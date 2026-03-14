// daemon/server — core daemon logic extracted for testability

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const execFileAsync = promisify(execFile);

export interface DaemonConfig {
  heartbeatTimeoutMs: number;
  checkIntervalMs: number;
  idleShutdownMs: number;
  silent: boolean;
}

export interface DaemonHandle {
  server: Server;
  heartbeats: Map<string, number>;
  events: EventEmitter;
  shutdown: () => void;
}

const DEFAULT_CONFIG: DaemonConfig = {
  heartbeatTimeoutMs: 15_000,
  checkIntervalMs: 5_000,
  idleShutdownMs: 60_000,
  silent: false,
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
  const heartbeats = new Map<string, number>();
  const events = new EventEmitter();
  let lastActivityTime = Date.now();

  async function cleanupWorktree(worktreeName: string): Promise<void> {
    console.log(`[daemon] No heartbeat for "${worktreeName}" — triggering cleanup`);
    heartbeats.delete(worktreeName);
    events.emit("cleanup", worktreeName);

    // Kill tmux session
    try {
      await execFileAsync("tmux", ["kill-session", "-t", worktreeName]);
      console.log(`[daemon] Killed tmux session: ${worktreeName}`);
    } catch {
      // Session may not exist
    }

    // Delete worktree via git
    try {
      await execFileAsync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreeName]);
      console.log(`[daemon] Removed worktree: ${worktreeName}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] Failed to remove worktree "${worktreeName}": ${msg}`);
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
          if (msg.type === "heartbeat" && typeof msg.worktree === "string") {
            heartbeats.set(msg.worktree, Date.now());
            lastActivityTime = Date.now();
            if (!cfg.silent) {
              const seqStr = typeof msg.seq === "number" ? ` #${msg.seq}` : "";
              console.log(`[daemon] Received heartbeat${seqStr} ← "${msg.worktree}"`);
            }
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
    console.log(`[daemon] Listening on ${socketPath}`);
    events.emit("listening");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[daemon] Socket already in use: ${socketPath}`);
    }
    events.emit("error", err);
  });

  const checkInterval = setInterval(() => {
    const now = Date.now();

    for (const [worktree, lastSeen] of heartbeats) {
      if (now - lastSeen > cfg.heartbeatTimeoutMs) {
        cleanupWorktree(worktree);
      }
    }

    if (heartbeats.size === 0 && now - lastActivityTime > cfg.idleShutdownMs) {
      console.log("[daemon] Idle — shutting down");
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
      console.log("[daemon] Shut down");
    });
  }

  return { server, heartbeats, events, shutdown };
}
