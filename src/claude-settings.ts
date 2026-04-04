// claude-settings module -- auto-generate .claude/settings.local.json for worktrees

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export type ClaudeSettingsStatus = "created" | "updated" | "unchanged";

interface ClaudeSettingsJson {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown;
}

const DEFAULT_WORKTREE_PERMISSIONS: string[] = [
  "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
  "mcp__plugin_context-mode_context-mode__ctx_execute_file",
  "mcp__plugin_context-mode_context-mode__ctx_search",
  "mcp__plugin_context-mode_context-mode__ctx_execute",
  "mcp__plugin_context-mode_context-mode__ctx_stats",
  "WebSearch",
  "Bash(npm run:*)",
  "Bash(npx tsc:*)",
  "Bash(tmux capture-pane:*)",
  "Bash(tmux list-sessions:*)",
  "Bash(tmux send-keys:*)",
  "Bash(tmux list-panes:*)",
  "Bash(git add:*)",
  "Bash(git fetch:*)",
  "Bash(git rebase:*)",
  "Bash(npx vitest:*)",
  "Bash(git stash:*)",
  "Bash(git commit:*)"
];

/**
 * Ensure .claude/settings.local.json exists in the worktree with default permissions.
 * Merges into existing file if present; creates from scratch otherwise.
 */
export async function writeClaudeSettingsFile(
  worktreePath: string,
  logger?: Logger,
): Promise<ClaudeSettingsStatus> {
  const claudeDir = join(worktreePath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  let existing: ClaudeSettingsJson | null = null;
  try {
    const raw = await readFile(settingsPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid JSON — will create from scratch
  }

  if (existing) {
    if (!existing.permissions) {
      existing.permissions = {};
    }
    if (!Array.isArray(existing.permissions.allow)) {
      existing.permissions.allow = [];
    }

    const currentAllow = existing.permissions.allow;
    const toAdd = DEFAULT_WORKTREE_PERMISSIONS.filter(
      (perm) => !currentAllow.includes(perm),
    );

    if (toAdd.length === 0) {
      logger?.log("[claude-settings] All default permissions already present");
      return "unchanged";
    }

    currentAllow.push(...toAdd);
    await writeFile(settingsPath, JSON.stringify(existing, null, 2) + "\n");
    logger?.log(`[claude-settings] Added ${toAdd.length} permissions to settings.local.json`);
    return "updated";
  }

  const settingsJson: ClaudeSettingsJson = {
    permissions: {
      allow: [...DEFAULT_WORKTREE_PERMISSIONS],
    },
  };

  await mkdir(claudeDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settingsJson, null, 2) + "\n");
  logger?.log("[claude-settings] Created .claude/settings.local.json with default permissions");
  return "created";
}
