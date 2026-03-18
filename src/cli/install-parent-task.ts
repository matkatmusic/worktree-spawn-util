#!/usr/bin/env node

// Detects if worktree-spawn-util is a git submodule and installs
// the "Worktree: Pick Repository" VS Code task into the parent repo.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getSuperprojectRoot } from "../git.js";

const TASK_LABEL = "Worktree: Pick Repository";
const BUILD_LABEL = "Build (worktree-spawn-util)";
const INPUT_ID = "worktreeName";

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
    tasksJson = JSON.parse(raw);
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

  // Inject Build task (namespaced to avoid collision)
  if (!tasksJson.tasks.some((t) => t.label === BUILD_LABEL)) {
    tasksJson.tasks.push({
      label: BUILD_LABEL,
      type: "shell",
      command: "npm",
      args: ["run", "build"],
      options: { cwd: `\${workspaceFolder}/${relPath}` },
      group: "build",
      presentation: { reveal: "silent" },
      problemMatcher: ["$tsc"],
    });
  }

  // Inject Pick Repository task
  tasksJson.tasks.push({
    label: TASK_LABEL,
    type: "shell",
    command: "node",
    args: [
      `\${workspaceFolder}/${relPath}/dist/cli/pick-repo.js`,
      `\${input:${INPUT_ID}}`,
    ],
    presentation: { reveal: "always", panel: "new", focus: true },
    problemMatcher: [],
    dependsOn: [BUILD_LABEL],
  });

  // Inject worktreeName input if missing
  if (!tasksJson.inputs!.some((i) => i.id === INPUT_ID)) {
    tasksJson.inputs!.push({
      id: INPUT_ID,
      type: "promptString",
      description: "Worktree name",
    });
  }

  // Write back
  await mkdir(vscodeDir, { recursive: true });
  await writeFile(tasksPath, JSON.stringify(tasksJson, null, 2) + "\n");
  console.log(`[install-parent-task] Installed "${TASK_LABEL}" into ${tasksPath}`);
}

main().catch((err) => {
  console.error("[install-parent-task] Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
