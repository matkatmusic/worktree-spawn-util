#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import { validateRepo, createWorktree } from "../git.js";
import { detectIde, launchIde, writeWorktreeTasksFile } from "../ide.js";
import { getSocketPath, ensureSocketDir, isSocketAlive, getDaemonSessionName } from "../socket.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

/** Replace characters invalid in git ref names with underscores. */
function sanitizeWorktreeName(raw: string): string {
  return raw
    .replace(/[ ~^:?*[\]\\]/g, "_") // invalid single chars
    .replace(/\.\./g, "_")          // no double dots
    .replace(/@\{/g, "_")           // no @{
    .replace(/\.lock$/g, "")        // no .lock suffix
    .replace(/^[./]+|[./]+$/g, "")  // no leading/trailing . or /
    .replace(/\/{2,}/g, "/")        // no consecutive slashes
    .replace(/_{2,}/g, "_")         // collapse consecutive underscores
    .replace(/^_+|_+$/g, "");       // trim leading/trailing underscores
}

async function pickFolder(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select a git repository")',
    ]);
    return stdout.trim() || null;
  } catch {
    // User cancelled the dialog
    return null;
  }
}

// --- Parse args ---
const cliArgs = process.argv.slice(2);
const visible = cliArgs.includes("--inspectHB");
const rawName = cliArgs.find((a) => !a.startsWith("--")) ?? "";

if (!rawName.trim()) {
  console.error("[pick-repo] No worktree name provided.");
  process.exit(1);
}

const worktreeName = sanitizeWorktreeName(rawName.trim());

if (!worktreeName) {
  console.error("[pick-repo] Worktree name is empty after sanitization.");
  process.exit(1);
}

if (worktreeName !== rawName.trim()) {
  console.log(`[pick-repo] Sanitized name: "${rawName.trim()}" → "${worktreeName}"`);
}

// --- Repo picker ---
const folder = await pickFolder();

if (!folder) {
  console.error("[pick-repo] No folder selected.");
  process.exit(1);
}

const selection = await validateRepo(folder);

if (!selection.isValid) {
  console.error(`[pick-repo] Not a git repository: ${folder}`);
  process.exit(1);
}

console.log(`[pick-repo] Repo: ${selection.repoRoot}`);

// --- Create worktree ---
let worktreePath: string;
try {
  const result = await createWorktree(selection.repoRoot, worktreeName);
  worktreePath = result.path;
  console.log(`[pick-repo] Worktree created at: ${result.path}`);
  console.log(`[pick-repo] Branch: ${result.branch}`);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[pick-repo] Failed to create worktree: ${message}`);
  process.exit(1);
}

// --- Ensure daemon is running ---
const socketPath = await getSocketPath(selection.repoRoot);
const daemonAlive = await isSocketAlive(socketPath);

if (!daemonAlive) {
  ensureSocketDir();
  const daemonPath = join(__dirname, "daemon.js");
  const sessionName = await getDaemonSessionName(selection.repoRoot);
  const daemonCmd = `node "${daemonPath}" "${selection.repoRoot}"`;

  try {
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, daemonCmd]);
    console.log(`[pick-repo] Started daemon in tmux session "${sessionName}"`);
  } catch {
    // tmux may not be available — fall back to detached spawn
    const daemonProc = spawn("node", [daemonPath, selection.repoRoot], {
      detached: true,
      stdio: "ignore",
    });
    daemonProc.unref();
    console.log(`[pick-repo] Started daemon (PID ${daemonProc.pid}) for ${selection.repoRoot}`);
  }

  // Poll until daemon socket is live (max 5s)
  const pollStart = Date.now();
  while (Date.now() - pollStart < 5000) {
    if (await isSocketAlive(socketPath)) {
      console.log("[pick-repo] Daemon socket is live");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await isSocketAlive(socketPath))) {
    console.warn("[pick-repo] WARNING: Daemon socket not ready after 5s — worktree cleanup may not work");
  }
} else {
  console.log("[pick-repo] Daemon already running for this repo");
}

// --- Create worktree tmux session (Claude top, terminal bottom) ---
try {
  await execFileAsync("tmux", [
    "new-session", "-d", "-s", worktreeName, "-c", worktreePath,
    "claude", "--permission-mode", "plan",
  ]);
  await execFileAsync("tmux", [
    "split-window", "-v", "-t", worktreeName, "-c", worktreePath,
  ]);
  await execFileAsync("tmux", [
    "select-pane", "-t", `${worktreeName}:0.0`,
  ]);
  console.log(`[pick-repo] Created tmux session "${worktreeName}" with Claude + terminal`);
} catch {
  console.log(`[pick-repo] Could not create tmux session (may already exist)`);
}

// --- Set up worktree IDE config ---
const tasksStatus = await writeWorktreeTasksFile(worktreePath, worktreeName, selection.repoRoot, visible);

// --- Open IDE window ---
const ide = detectIde();
if (ide) {
  launchIde(ide, worktreePath);
} else {
  console.log(`[pick-repo] Could not detect IDE. Open manually: ${worktreePath}`);
}

// --- Prompt to add .worktrees to .gitignore ---
const gitignorePath = join(selection.repoRoot, ".gitignore");
let gitignoreContent = "";
try {
  gitignoreContent = await readFile(gitignorePath, "utf-8");
} catch {
  // .gitignore may not exist yet
}

const alreadyIgnored = gitignoreContent
  .split("\n")
  .some((line) => line.trim() === ".worktrees");

if (!alreadyIgnored) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    "[pick-repo] Add .worktrees to .gitignore? (y/n) ",
  );
  rl.close();

  if (answer.trim().toLowerCase() === "y") {
    const suffix =
      gitignoreContent.endsWith("\n") || !gitignoreContent ? "" : "\n";
    await appendFile(gitignorePath, suffix + ".worktrees\n");
    console.log("[pick-repo] Added .worktrees to .gitignore");
  } else {
    console.log("[pick-repo] Skipped — .worktrees/ will appear as untracked");
  }
}
