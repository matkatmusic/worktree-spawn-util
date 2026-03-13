#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateRepo } from "../git/index.js";

const execFileAsync = promisify(execFile);

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

console.log(`[pick-repo] Selected: ${selection.repoRoot}`);
