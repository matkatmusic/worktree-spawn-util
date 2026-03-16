// ide module — configurable IDE launcher (code, agy, cursor, etc.)

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDaemonSessionName } from "../socket/index.js";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function addWorktreeSessionTask(existing: TasksJsonFile, worktreeName: string): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const label = `Worktree: ${worktreeName}`;
  if (tasks.some((t) => t.label === label)) {
    console.log(`[ide] "${label}" task already exists in tasks.json`);
    return tasks;
  }

  const task: Task = {
    label,
    type: "shell",
    command: `tmux attach -t ${worktreeName}`,
    runOptions: { runOn: "folderOpen" },
    presentation: { reveal: "always", panel: "dedicated", group: `worktree-${worktreeName}`, focus: true },
    isBackground: true,
    problemMatcher: [],
  };

  tasks.push(task);
  return tasks;
}

function addHeartbeatTask(existing: TasksJsonFile, worktreeName: string, repoRoot: string, visible?: boolean): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const heartbeatLabel = `Heartbeat: ${worktreeName}`;
  if (tasks.some((t) => t.label === heartbeatLabel)) {
    console.log(`[ide] "${heartbeatLabel}" task already exists in tasks.json`);
    return tasks;
  }

  const heartbeatTask: Task = {
    label: heartbeatLabel,
    type: "shell",
    command: `node "${join(__dirname, "..", "cli", "heartbeat.js")}" --repo-root "${repoRoot}" --worktree "${worktreeName}"`,
    runOptions: { runOn: "folderOpen" },
    presentation: {
      reveal: visible ? "always" : "never",
      panel: visible ? "dedicated" : "shared",
      group: visible ? `daemon-${worktreeName}` : `heartbeat-${worktreeName}`,
      focus: false,
    },
    isBackground: true,
    problemMatcher: [],
  };

  tasks.push(heartbeatTask);
  return tasks;
}

function addDaemonMonitorTask(existing: TasksJsonFile, worktreeName: string, sessionName: string): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const label = "Daemon Monitor";
  if (tasks.some((t) => t.label === label)) {
    console.log(`[ide] "${label}" task already exists in tasks.json`);
    return tasks;
  }

  const monitorTask: Task = {
    label,
    type: "shell",
    command: `tmux attach -t ${sessionName}`,
    runOptions: { runOn: "folderOpen" },
    presentation: { reveal: "always", panel: "dedicated", group: `daemon-${worktreeName}`, focus: false },
    isBackground: true,
    problemMatcher: [],
  };

  tasks.push(monitorTask);
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
  repoRoot?: string,
  visible?: boolean,
): Promise<TasksFileStatus> {
  const tasksPath = join(worktreePath, ".vscode", "tasks.json");
  const sessionName = (visible && repoRoot) ? await getDaemonSessionName(repoRoot) : undefined;

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
    if (repoRoot) {
      existing.tasks = addHeartbeatTask(existing, worktreeName, repoRoot, visible);
    }
    existing.tasks = addWorktreeSessionTask(existing, worktreeName);
    if (visible && sessionName) {
      existing.tasks = addDaemonMonitorTask(existing, worktreeName, sessionName);
    }

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

    if (repoRoot) {
      tasksJson.tasks = addHeartbeatTask(tasksJson, worktreeName, repoRoot, visible);
    }
    tasksJson.tasks = addWorktreeSessionTask(tasksJson, worktreeName);
    if (visible && sessionName) {
      tasksJson.tasks = addDaemonMonitorTask(tasksJson, worktreeName, sessionName);
    }

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
