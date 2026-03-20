#!/usr/bin/env node

// Detects if worktree-spawn-util is a git submodule and installs
// the "Worktree: Pick Repository" VS Code task into the parent repo.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getSuperprojectRoot } from "../git.js";
import {
  PICK_REPO_FLAG_INSPECT_HB,
  PICK_REPO_FLAG_PICK,
  DAEMON_FLAG_HEARTBEAT_TIMEOUT,
  DAEMON_FLAG_CHECK_INTERVAL,
} from "../cli-flags.js";

const TASK_LABEL = "Worktree: Pick Repository";
const INPUT_ID = "worktreeName";

function taskCommand(): string {
  return `npm run build && node dist/cli/pick-repo.js \${input:${INPUT_ID}}`;
}

function buildUsageComment(indent: string): string {
  const pad = indent + "   ";
  return [
    `${indent}/*`,
    `${indent}Optional args:`,
    `${pad}${PICK_REPO_FLAG_INSPECT_HB}: show heartbeat & daemon panels in worktree IDE`,
    `${pad}${PICK_REPO_FLAG_PICK} <path/to/repo>: force manual folder picker (skip submodule auto-detect)`,
    ` `,
    `${pad}Daemon-specific args (passed through when daemon starts):`,
    `${pad}${DAEMON_FLAG_HEARTBEAT_TIMEOUT}=<ms>: cleanup delay after last heartbeat (default 15000)`,
    `${pad}${DAEMON_FLAG_CHECK_INTERVAL}=<ms>: how often daemon checks for expired worktrees (default 5000)`,
    `${indent}*/`,
  ].join("\n");
}

/** Strip JSONC comments (// line comments and /* block comments) so JSON.parse() works. */
function stripJsonComments(text: string): string {
  // Strip block comments
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

interface TasksJsonFile {
  version: string;
  tasks: Record<string, unknown>[];
  inputs?: Record<string, unknown>[];
}

async function main() {
  const cwd = process.cwd();
  const superprojectRoot = await getSuperprojectRoot(cwd);

  if (!superprojectRoot) {
    console.log("[install-parent-task] Not a submodule — skipping.");
    return;
  }

  const relPath = relative(superprojectRoot, cwd);
  console.log(`[install-parent-task] Submodule detected at "${relPath}" inside "${superprojectRoot}"`);

  const vscodeDir = join(superprojectRoot, ".vscode");
  const tasksPath = join(vscodeDir, "tasks.json");

  // Read or create tasks.json
  let tasksJson: TasksJsonFile;
  try {
    const raw = await readFile(tasksPath, "utf-8");
    tasksJson = JSON.parse(stripJsonComments(raw));
    if (!Array.isArray(tasksJson.tasks)) {
      tasksJson.tasks = [];
    }
    if (!Array.isArray(tasksJson.inputs)) {
      tasksJson.inputs = [];
    }
  } catch {
    tasksJson = { version: "2.0.0", tasks: [], inputs: [] };
  }

  // Idempotency check
  if (tasksJson.tasks.some((t) => t.label === TASK_LABEL)) {
    console.log(`[install-parent-task] "${TASK_LABEL}" already exists — skipping.`);
    return;
  }

  // Inject consolidated task (build + pick-repo in one command)
  tasksJson.tasks.push({
    label: TASK_LABEL,
    type: "shell",
    command: taskCommand(),
    options: { cwd: `\${workspaceFolder}/${relPath}` },
    presentation: { reveal: "always", panel: "new", focus: true },
    problemMatcher: ["$tsc"],
  });

  // Inject worktreeName input if missing
  if (!tasksJson.inputs!.some((i) => i.id === INPUT_ID)) {
    tasksJson.inputs!.push({
      id: INPUT_ID,
      type: "promptString",
      description: "Worktree name",
    });
  }

  // Write back with usage comment above our command line
  await mkdir(vscodeDir, { recursive: true });
  const json = JSON.stringify(tasksJson, null, 2);
  const lines = json.split("\n");
  const cmdIdx = lines.findIndex((l) => l.includes(taskCommand()));
  if (cmdIdx !== -1) {
    const indent = lines[cmdIdx].match(/^(\s*)/)?.[1] ?? "";
    lines.splice(cmdIdx, 0, buildUsageComment(indent));
  }
  await writeFile(tasksPath, lines.join("\n") + "\n");
  console.log(`[install-parent-task] Installed "${TASK_LABEL}" into ${tasksPath}`);
}

main().catch((err) => {
  console.error("[install-parent-task] Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
