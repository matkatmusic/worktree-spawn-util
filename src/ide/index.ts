// ide module — configurable IDE launcher (code, agy, cursor, etc.)

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type IdeConfig = {
  command: string;
};

/** Map macOS bundle identifiers to CLI commands. */
const IDE_BUNDLE_MAP: Record<string, string> = {
  "com.microsoft.VSCode": "code",
  "com.microsoft.VSCodeInsiders": "code-insiders",
  "com.google.antigravity": "agy",
};

/** Detect which IDE spawned this process by checking environment variables. */
export function detectIde(): IdeConfig | null {
  // Primary: macOS bundle identifier (most reliable for VS Code forks)
  const bundleId = process.env.__CFBundleIdentifier;
  if (bundleId && bundleId in IDE_BUNDLE_MAP) {
    return { command: IDE_BUNDLE_MAP[bundleId] };
  }

  // Fallback: VSCODE_GIT_ASKPASS_NODE contains the app path
  const askpassNode = process.env.VSCODE_GIT_ASKPASS_NODE ?? "";
  if (askpassNode.includes("Visual Studio Code Insiders")) {
    return { command: "code-insiders" };
  }
  if (askpassNode.includes("Visual Studio Code")) {
    return { command: "code" };
  }
  if (askpassNode.includes("Antigravity")) {
    return { command: "agy" };
  }

  return null;
}

/** Open a new IDE window at the given path. The process is detached so it outlives the caller. */
export function launchIde(config: IdeConfig, worktreePath: string): void {
  const child = spawn(config.command, [worktreePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`[ide] Opened ${config.command} at ${worktreePath}`);
}

export type TasksFileStatus = "created" | "updated" | "unchanged";

interface Task {
  label: string;
  type: string;
  command: string;
  runOptions: { runOn: string };
  presentation: { reveal: string; panel: string; group: string; focus: boolean };
  isBackground: boolean;
  problemMatcher: string[];
}

interface TasksJsonFile {
  version: string;
  tasks: Task[];
}

function addClaudeTask(existing: TasksJsonFile, worktreeName: string): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  if (tasks.some((t) => t.label === "Launch Claude")) {
    console.log(`[ide] "Launch Claude" task already exists in tasks.json`);
    return tasks;
  }

  const claudeTask: Task = {
    label: "Launch Claude",
    type: "shell",
    command: "claude --permission-mode plan",
    runOptions: { runOn: "folderOpen" },
    presentation: { reveal: "always", panel: "dedicated", group: `worktree-${worktreeName}`, focus: true },
    isBackground: true,
    problemMatcher: [],
  };

  tasks.push(claudeTask);
  return tasks;
}

function addTmuxTask(existing: TasksJsonFile, worktreeName: string): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const tmuxLabel = `tmux: ${worktreeName}`;
  if (tasks.some((t) => t.label === tmuxLabel)) {
    console.log(`[ide] "${tmuxLabel}" task already exists in tasks.json`);
    return tasks;
  }

  const tmuxTask: Task = {
    label: tmuxLabel,
    type: "shell",
    command: `tmux new-session -A -s ${worktreeName}`,
    runOptions: { runOn: "folderOpen" },
    presentation: { reveal: "always", panel: "dedicated", group: `worktree-${worktreeName}`, focus: false },
    isBackground: true,
    problemMatcher: [],
  };

  tasks.push(tmuxTask);
  return tasks;
}

async function writeUpdatedTasks(tasksJson: TasksJsonFile, tasksPath: string): Promise<void> {
  await writeFile(tasksPath, JSON.stringify(tasksJson, null, 2) + "\n");
  console.log(`[ide] Updated tasks.json`);
}

/**
 * Ensure "Launch Claude" and tmux tasks exist in the worktree's .vscode/tasks.json.
 * Creates the file if missing, or merges tasks into an existing file.
 */
export async function writeWorktreeTasksFile(
  worktreePath: string,
  worktreeName: string,
): Promise<TasksFileStatus> {
  const tasksPath = join(worktreePath, ".vscode", "tasks.json");

  // Try to read existing tasks.json
  let existing: TasksJsonFile | null = null;

  try {
    const raw = await readFile(tasksPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't valid JSON — will create from scratch
  }

  if (existing) {
    const originalLength = Array.isArray(existing.tasks) ? existing.tasks.length : 0;
    existing.tasks = addClaudeTask(existing, worktreeName);
    existing.tasks = addTmuxTask(existing, worktreeName);

    if (existing.tasks.length === originalLength) {
      return "unchanged";
    }

    await writeUpdatedTasks(existing, tasksPath);
    return "updated";
  } else {
    const tasksJson: TasksJsonFile = {
      version: "2.0.0",
      tasks: [],
    };

    tasksJson.tasks = addClaudeTask(tasksJson, worktreeName);
    tasksJson.tasks = addTmuxTask(tasksJson, worktreeName);

    await mkdir(join(worktreePath, ".vscode"), { recursive: true });
    await writeUpdatedTasks(tasksJson, tasksPath);
    return "created";
  }
}

/**
 * Reload an IDE window via AppleScript.
 * Activates the app by bundle ID, opens Command Palette, types "Reload Window", presses Enter.
 */
export async function reloadIdeWindow(bundleId: string): Promise<void> {
  const script = `
    tell application id "${bundleId}"
      activate
    end tell
    delay 1
    tell application "System Events"
      keystroke "p" using {command down, shift down}
      delay 0.5
      keystroke "Reload Window"
      delay 0.3
      key code 36
    end tell
  `;
  try {
    await execFileAsync("osascript", ["-e", script]);
    console.log(`[ide] Reloaded IDE window`);
  } catch {
    console.log(
      `[ide] Could not reload IDE window automatically. Use Command Palette > "Developer: Reload Window"`,
    );
  }
}
