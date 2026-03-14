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

const LAUNCH_CLAUDE_TASK = {
  label: "Launch Claude",
  type: "shell",
  command: "claude --permission-mode plan",
  runOptions: { runOn: "folderOpen" },
  presentation: { reveal: "always", focus: true },
  problemMatcher: [] as string[],
};

export type TasksFileStatus = "created" | "updated" | "unchanged";

/**
 * Ensure a "Launch Claude" task exists in the worktree's .vscode/tasks.json.
 * Creates the file if missing, or merges the task into an existing file.
 */
export async function writeWorktreeTasksFile(
  worktreePath: string,
  _worktreeName: string,
): Promise<TasksFileStatus> {
  const tasksPath = join(worktreePath, ".vscode", "tasks.json");

  // Try to read existing tasks.json
  let existing: { version?: string; tasks?: { label?: string }[] } | null =
    null;
  try {
    const raw = await readFile(tasksPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or isn't valid JSON — will create from scratch
  }

  if (existing) {
    const tasks = Array.isArray(existing.tasks) ? existing.tasks : [];
    if (tasks.some((t) => t.label === "Launch Claude")) {
      console.log(`[ide] "Launch Claude" task already exists in tasks.json`);
      return "unchanged";
    }
    tasks.push(LAUNCH_CLAUDE_TASK);
    existing.tasks = tasks;
    await writeFile(tasksPath, JSON.stringify(existing, null, 2) + "\n");
    console.log(`[ide] Added "Launch Claude" task to existing tasks.json`);
    return "updated";
  } else {
    const tasksJson = {
      version: "2.0.0",
      tasks: [LAUNCH_CLAUDE_TASK],
    };
    await mkdir(join(worktreePath, ".vscode"), { recursive: true });
    await writeFile(tasksPath, JSON.stringify(tasksJson, null, 2) + "\n");
    console.log(`[ide] Created .vscode/tasks.json with "Launch Claude" task`);
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

