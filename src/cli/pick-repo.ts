#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateRepo } from "../git/index.js";

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

// --- Worktree name ---
const rawName = process.argv[2] ?? "";

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
console.log(`[pick-repo] Worktree: ${worktreeName}`);
