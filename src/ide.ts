// ide module — configurable IDE launcher (code, agy, cursor, etc.)

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDaemonSessionName } from "./socket.js";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

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
export function launchIde(config: IdeConfig, worktreePath: string, logger?: Logger): void {
  const child = spawn(config.command, [worktreePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logger?.log(`[ide] Opened ${config.command} at ${worktreePath}`);
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

function addWorktreeSessionTask(existing: TasksJsonFile, worktreeName: string, logger?: Logger): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const label = `Worktree: ${worktreeName}`;
  if (tasks.some((t) => t.label === label)) {
    logger?.log(`[ide] "${label}" task already exists in tasks.json`);
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

function addHeartbeatTask(existing: TasksJsonFile, worktreeName: string, repoRoot: string, visible?: boolean, logger?: Logger): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const heartbeatLabel = `Heartbeat: ${worktreeName}`;
  if (tasks.some((t) => t.label === heartbeatLabel)) {
    logger?.log(`[ide] "${heartbeatLabel}" task already exists in tasks.json`);
    return tasks;
  }

  const heartbeatTask: Task = {
    label: heartbeatLabel,
    type: "shell",
    command: `node "${join(__dirname, "cli", "heartbeat.js")}" --repo-root "${repoRoot}" --worktree "${worktreeName}"`,
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

function addDaemonMonitorTask(existing: TasksJsonFile, worktreeName: string, sessionName: string, logger?: Logger): Task[] {
  const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
  const label = "Daemon Monitor";
  if (tasks.some((t) => t.label === label)) {
    logger?.log(`[ide] "${label}" task already exists in tasks.json`);
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

async function writeUpdatedTasks(tasksJson: TasksJsonFile, tasksPath: string, logger?: Logger): Promise<void> {
  await writeFile(tasksPath, JSON.stringify(tasksJson, null, 2) + "\n");
  logger?.log(`[ide] Updated tasks.json`);
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
  logger?: Logger,
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
      existing.tasks = addHeartbeatTask(existing, worktreeName, repoRoot, visible, logger);
    }
    existing.tasks = addWorktreeSessionTask(existing, worktreeName, logger);
    if (visible && sessionName) {
      existing.tasks = addDaemonMonitorTask(existing, worktreeName, sessionName, logger);
    }

    if (existing.tasks.length === originalLength) {
      return "unchanged";
    }

    await writeUpdatedTasks(existing, tasksPath, logger);
    return "updated";
  } else {
    const tasksJson: TasksJsonFile = {
      version: "2.0.0",
      tasks: [],
    };

    if (repoRoot) {
      tasksJson.tasks = addHeartbeatTask(tasksJson, worktreeName, repoRoot, visible, logger);
    }
    tasksJson.tasks = addWorktreeSessionTask(tasksJson, worktreeName, logger);
    if (visible && sessionName) {
      tasksJson.tasks = addDaemonMonitorTask(tasksJson, worktreeName, sessionName, logger);
    }

    await mkdir(join(worktreePath, ".vscode"), { recursive: true });
    await writeUpdatedTasks(tasksJson, tasksPath, logger);
    return "created";
  }
}

/**
 * Reload an IDE window via AppleScript.
 * Activates the app by bundle ID, opens Command Palette, types "Reload Window", presses Enter.
 */
export async function reloadIdeWindow(bundleId: string, logger?: Logger): Promise<void> {
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
    logger?.log(`[ide] Reloaded IDE window`);
  } catch {
    logger?.log(
      `[ide] Could not reload IDE window automatically. Use Command Palette > "Developer: Reload Window"`,
    );
  }
}

/** Send a macOS system notification. */
export async function notifyUser(title: string, message: string, logger?: Logger): Promise<void> {
  try {
    await execFileAsync("osascript", [
      "-e",
      `display notification "${message}" with title "${title}"`,
    ]);
  } catch {
    // Notification failed — best effort
  }
}
