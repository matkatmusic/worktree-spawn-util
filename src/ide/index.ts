// ide module — configurable IDE launcher (code, agy, cursor, etc.)

import { spawn } from "node:child_process";

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
