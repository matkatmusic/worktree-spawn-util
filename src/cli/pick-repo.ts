#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import { validateRepo, createWorktree, getSuperprojectRoot } from "../git.js";
import { detectIde, launchIde, writeWorktreeTasksFile, openDaemonLogTerminal } from "../ide.js";
import { getSocketPath, ensureSocketDir, isSocketAlive, getDaemonSessionName, getDaemonLogPath } from "../socket.js";
import { Logger } from "../logger.js";
import { setupNodeProject } from "../node-setup.js";
import { writeClaudeSettingsFile } from "../claude-settings.js";
import { PICK_REPO_FLAG_INSPECT_HB, PICK_REPO_FLAG_PICK } from "../cli-flags.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

const logger = new Logger();

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
const visible = cliArgs.includes(PICK_REPO_FLAG_INSPECT_HB);
const forcePick = cliArgs.includes(PICK_REPO_FLAG_PICK);
const rawName = cliArgs.filter((a) => !a.startsWith("--")).join("_");

if (!rawName.trim()) {
  logger.error("[pick-repo] No worktree name provided.");
  process.exit(1);
}

const worktreeName = sanitizeWorktreeName(rawName.trim());

if (!worktreeName) {
  logger.error("[pick-repo] Worktree name is empty after sanitization.");
  process.exit(1);
}

if (worktreeName !== rawName.trim()) {
  logger.log(`[pick-repo] Sanitized name: "${rawName.trim()}" -> "${worktreeName}"`);
}

// --- Repo picker (auto-detect submodule parent or prompt) ---
let folder: string | null = null;

if (!forcePick) {
  const superproject = await getSuperprojectRoot(__dirname);
  if (superproject) {
    folder = superproject;
    logger.log(`[pick-repo] Auto-detected parent repo (submodule): ${folder}`);
  }
}

if (!folder) {
  folder = await pickFolder();
}

if (!folder) {
  logger.error("[pick-repo] No folder selected.");
  process.exit(1);
}

const selection = await validateRepo(folder, logger);

if (!selection.isValid) {
  logger.error(`[pick-repo] Not a git repository: ${folder}`);
  process.exit(1);
}

logger.log(`[pick-repo] Repo: ${selection.repoRoot}`);

// --- Capture parent branch info before creating worktree ---
let parentBranch = "";
let parentCommit = "";
try {
  const branchResult = await execFileAsync("git", ["-C", selection.repoRoot, "symbolic-ref", "--short", "HEAD"]);
  parentBranch = branchResult.stdout.trim();
  const commitResult = await execFileAsync("git", ["-C", selection.repoRoot, "rev-parse", "HEAD"]);
  parentCommit = commitResult.stdout.trim();
  logger.log(`[pick-repo] Parent: ${parentBranch}@${parentCommit.slice(0, 7)}`);
} catch {
  logger.warn("[pick-repo] Could not determine parent branch/commit");
}

// --- Create worktree ---
let worktreePath: string;
try {
  const result = await createWorktree(selection.repoRoot, worktreeName, logger);
  worktreePath = result.path;
  logger.log(`[pick-repo] Worktree created at: ${result.path}`);
  logger.log(`[pick-repo] Branch: ${result.branch}`);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[pick-repo] Failed to create worktree: ${message}`);
  process.exit(1);
}

// --- Detect IDE early (before daemon start, so we can open terminal in parent window) ---
const ide = detectIde();

// --- Check daemon status ---
const socketPath = await getSocketPath(selection.repoRoot);
const daemonAlive = await isSocketAlive(socketPath);

// --- Ensure socket dir + log file exist before opening terminal ---
ensureSocketDir();
const logPath = await getDaemonLogPath(selection.repoRoot);

// Touch log file with marker (only on first create)
try {
  writeFileSync(logPath, "Waiting for daemon...\n", { flag: "ax" });
} catch {
  // File already exists — fine
}

// --- Open daemon log terminal in parent IDE (before daemon start so tail catches header) ---
if (!daemonAlive && ide && ide.uriScheme) {
  openDaemonLogTerminal(ide.uriScheme, logPath, basename(selection.repoRoot), logger);
}

// --- Start daemon if needed ---
if (!daemonAlive) {
  const daemonPath = join(__dirname, "daemon.js");
  const sessionName = await getDaemonSessionName(selection.repoRoot);
  const daemonCmd = `node "${daemonPath}" "${selection.repoRoot}"`;

  try {
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, daemonCmd]);
    logger.log(`[pick-repo] Started daemon in tmux session "${sessionName}"`);
  } catch {
    // tmux may not be available — fall back to detached spawn
    const daemonProc = spawn("node", [daemonPath, selection.repoRoot], {
      detached: true,
      stdio: "ignore",
    });
    daemonProc.unref();
    logger.log(`[pick-repo] Started daemon (PID ${daemonProc.pid}) for ${selection.repoRoot}`);
  }

  // Poll until daemon socket is live (max 5s)
  const pollStart = Date.now();
  while (Date.now() - pollStart < 5000) {
    if (await isSocketAlive(socketPath)) {
      logger.log("[pick-repo] Daemon socket is live");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await isSocketAlive(socketPath))) {
    logger.warn("[pick-repo] WARNING: Daemon socket not ready after 5s");
  }
} else {
  logger.log("[pick-repo] Daemon already running for this repo");
}

// --- Register worktree with daemon ---
if (parentBranch && parentCommit) {
  await new Promise<void>((resolve) => {
    const regClient = createConnection({ path: socketPath }, () => {
      regClient.write(JSON.stringify({ type: "register", worktree: worktreeName, parentBranch, parentCommit }) + "\n");
      regClient.end();
      resolve();
    });
    regClient.on("error", () => {
      logger.warn("[pick-repo] Could not register worktree with daemon");
      resolve();
    });
  });
}

// --- Create worktree tmux session (Claude top, terminal bottom) ---
try {
  await execFileAsync("tmux", [
    "new-session", "-d", "-s", worktreeName, "-c", worktreePath,
    "zsh", "-c", "source ~/.claude/init.sh && claude --permission-mode plan",
  ]);
  await execFileAsync("tmux", [
    "split-window", "-v", "-t", worktreeName, "-c", worktreePath,
  ]);
  await execFileAsync("tmux", [
    "select-pane", "-t", `${worktreeName}:0.0`,
  ]);
  // Wait for Claude to initialize, then rename the conversation
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await execFileAsync("tmux", [
    "send-keys", "-t", `${worktreeName}:0.0`,
    `/rename ${worktreeName}`, "Enter",
  ]);
  logger.log(`[pick-repo] Created tmux session "${worktreeName}" with Claude + terminal`);
} catch {
  logger.log(`[pick-repo] Could not create tmux session (may already exist)`);
}

// --- Set up worktree IDE config ---
const tasksStatus = await writeWorktreeTasksFile(worktreePath, worktreeName, selection.repoRoot, visible, logger);

// Prevent worktree-specific tasks.json changes from being committed
try {
  await execFileAsync("git", [
    "-C", worktreePath,
    "update-index", "--skip-worktree", ".vscode/tasks.json",
  ]);
  logger.log("[pick-repo] Marked .vscode/tasks.json as skip-worktree");
} catch {
  logger.warn("[pick-repo] Could not set skip-worktree on tasks.json");
}

// --- Claude settings (default permissions) ---
await writeClaudeSettingsFile(worktreePath, logger);

// --- Node project setup (npm install + build) ---
await setupNodeProject(worktreePath, logger);

// --- Open IDE window ---
if (ide) {
  launchIde(ide, worktreePath, logger);
} else {
  logger.log(`[pick-repo] Could not detect IDE. Open manually: ${worktreePath}`);
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
    logger.log("[pick-repo] Added .worktrees to .gitignore");
  } else {
    logger.log("[pick-repo] Skipped — .worktrees/ will appear as untracked");
  }
}
