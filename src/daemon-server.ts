// daemon/server — core daemon logic extracted for testability

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { isBranchMerged, hasNewCommits, onlyIgnorableChanges, removeWorktreeAndBranch } from "./git.js";
import { notifyUser } from "./ide.js";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface DaemonConfig {
  heartbeatTimeoutMs: number;
  checkIntervalMs: number;
  idleShutdownMs: number;
  logger?: Logger;
}

export interface WorktreeState {
  lastHeartbeat: number;
  parentBranch: string;
  parentCommit: string;
}

export interface PendingRegistration {
  parentBranch: string;
  parentCommit: string;
}

export interface DaemonHandle {
  server: Server;
  heartbeats: Map<string, WorktreeState>;
  pendingRegistrations: Map<string, PendingRegistration>;
  events: EventEmitter;
  shutdown: () => void;
}

const DEFAULT_CONFIG: DaemonConfig = {
  heartbeatTimeoutMs: 15_000,
  checkIntervalMs: 5_000,
  idleShutdownMs: 60_000,
};

/**
 * Create and start a daemon server on the given Unix socket path.
 *
 * Events emitted on `handle.events`:
 * - `"cleanup"` (worktreeName: string) — when a worktree heartbeat times out
 * - `"idle-shutdown"` — when the daemon shuts down due to inactivity
 * - `"listening"` — when the server is ready
 */
export function createDaemonServer(
  socketPath: string,
  repoRoot: string,
  config: Partial<DaemonConfig> = {},
): DaemonHandle {
  const cfg: DaemonConfig = { ...DEFAULT_CONFIG, ...config };
  const logger = cfg.logger;
  const heartbeats = new Map<string, WorktreeState>();
  const pendingRegistrations = new Map<string, PendingRegistration>();
  const events = new EventEmitter();
  let lastActivityTime = Date.now();

  // Session header is written by the CLI caller (cli/daemon.ts) before creating the server

  async function cleanupWorktree(worktreeName: string, state: WorktreeState): Promise<void> {
    logger?.log(`[daemon] No heartbeat for "${worktreeName}" — evaluating cleanup`);
    events.emit("cleanup", worktreeName);

    // Always kill tmux session
    try {
      await execFileAsync("tmux", ["kill-session", "-t", worktreeName]);
      logger?.log(`[daemon] Killed tmux session: ${worktreeName}`);
    } catch {
      // Session may not exist
    }

    const worktreePath = join(repoRoot, ".worktrees", worktreeName);

    if (!state.parentBranch || !state.parentCommit) {
      // No parent info — force delete (legacy behavior)
      logger?.log(`[daemon] No parent info for "${worktreeName}" — force deleting`);
      try {
        await removeWorktreeAndBranch(repoRoot, worktreeName, logger);
        logger?.log(`[daemon] Removed worktree and branch: ${worktreeName}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.error(`[daemon] Failed to remove worktree "${worktreeName}": ${msg}`);
      }
      return;
    }

    try {
      // 1. Check for unstaged/uncommitted changes outside .claude/ and .vscode/
      const ignorable = await onlyIgnorableChanges(worktreePath, logger);
      if (!ignorable) {
        logger?.log(`[daemon] Worktree "${worktreeName}" has uncommitted changes — preserving`);
        await notifyUser("Worktree Preserved", `"${worktreeName}" has uncommitted changes.`, logger);
        return;
      }

      // 2. Check if branch has commits beyond parent
      const commits = await hasNewCommits(repoRoot, worktreeName, state.parentCommit, logger);
      if (!commits) {
        logger?.log(`[daemon] No commits on "${worktreeName}" — deleting`);
        await removeWorktreeAndBranch(repoRoot, worktreeName, logger);
        logger?.log(`[daemon] Removed worktree and branch: ${worktreeName}`);
        return;
      }

      // 3. Has commits — check if merged into parent
      const merged = await isBranchMerged(repoRoot, worktreeName, state.parentBranch, logger);
      if (merged) {
        logger?.log(`[daemon] Branch "${worktreeName}" is merged into "${state.parentBranch}" — deleting`);
        await removeWorktreeAndBranch(repoRoot, worktreeName, logger);
        logger?.log(`[daemon] Removed worktree and branch: ${worktreeName}`);
        return;
      }

      // Has unmerged commits — preserve
      logger?.log(`[daemon] Worktree "${worktreeName}" has unmerged commits — preserving`);
      await notifyUser("Worktree Preserved", `"${worktreeName}" has unmerged commits.`, logger);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error(`[daemon] Error evaluating cleanup for "${worktreeName}": ${msg}`);
      // On error, preserve the worktree to be safe
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          if (msg.type === "register" && typeof msg.worktree === "string" && msg.parentBranch && msg.parentCommit) {
            const existing = heartbeats.get(msg.worktree);
            if (existing) {
              // Re-registration: update parent info in-place
              existing.parentBranch = msg.parentBranch;
              existing.parentCommit = msg.parentCommit;
            } else {
              // Store as pending — timeout tracking starts on first heartbeat
              pendingRegistrations.set(msg.worktree, {
                parentBranch: msg.parentBranch,
                parentCommit: msg.parentCommit,
              });
            }
            lastActivityTime = Date.now();
            logger?.log(`[daemon] Registered worktree "${msg.worktree}" (parent: ${msg.parentBranch}@${msg.parentCommit.slice(0, 7)})`);
          } else if (msg.type === "heartbeat" && typeof msg.worktree === "string") {
            const pending = pendingRegistrations.get(msg.worktree);
            if (pending) {
              // First heartbeat for a pending registration — activate tracking
              heartbeats.set(msg.worktree, {
                lastHeartbeat: Date.now(),
                parentBranch: pending.parentBranch,
                parentCommit: pending.parentCommit,
              });
              pendingRegistrations.delete(msg.worktree);
            } else {
              const active = heartbeats.get(msg.worktree);
              if (active) {
                active.lastHeartbeat = Date.now();
              } else {
                heartbeats.set(msg.worktree, { lastHeartbeat: Date.now(), parentBranch: "", parentCommit: "" });
              }
            }
            lastActivityTime = Date.now();
            const seqStr = typeof msg.seq === "number" ? ` #${msg.seq}` : "";
            logger?.log(`[daemon] Received heartbeat${seqStr} <- "${msg.worktree}"`);
          }
        } catch {
          // Ignore malformed messages
        }
      }
    });

    socket.on("error", () => {
      // Client disconnected unexpectedly
    });
  });

  server.listen(socketPath, () => {
    logger?.log(`[daemon] Listening on ${socketPath}`);
    events.emit("listening");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger?.error(`[daemon] Socket already in use: ${socketPath}`);
    }
    events.emit("error", err);
  });

  const checkInterval = setInterval(async () => {
    const now = Date.now();

    const expired: Array<{ name: string; state: WorktreeState }> = [];
    for (const [worktree, state] of heartbeats) {
      if (now - state.lastHeartbeat > cfg.heartbeatTimeoutMs) {
        expired.push({ name: worktree, state });
      }
    }
    for (const { name, state } of expired) {
      heartbeats.delete(name);
      await cleanupWorktree(name, state);
    }

    if (heartbeats.size === 0 && pendingRegistrations.size === 0 && now - lastActivityTime > cfg.idleShutdownMs) {
      logger?.log("[daemon] Idle — shutting down");
      logger?.log("=== SESSION END (idle-shutdown) ===");
      events.emit("idle-shutdown");
      shutdown();
    }
  }, cfg.checkIntervalMs);

  function shutdown(): void {
    clearInterval(checkInterval);
    server.close(() => {
      try {
        unlinkSync(socketPath);
      } catch {
        // Already cleaned up
      }
      logger?.log("[daemon] Shut down");
    });
  }

  return { server, heartbeats, pendingRegistrations, events, shutdown };
}
