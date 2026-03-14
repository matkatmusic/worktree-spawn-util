// heartbeat/client — heartbeat sending logic extracted for testability

import { createConnection } from "node:net";

/** Parse --repo-root and --worktree from CLI args. */
export function parseArgs(args: string[]): { repoRoot: string; worktree: string } {
  let repoRoot = "";
  let worktree = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root" && args[i + 1]) {
      repoRoot = args[i + 1];
      i++;
    } else if (args[i] === "--worktree" && args[i + 1]) {
      worktree = args[i + 1];
      i++;
    }
  }

  return { repoRoot, worktree };
}

let heartbeatCount = 0;

/** Send a single heartbeat message to the daemon over a Unix socket. */
export function sendHeartbeat(socketPath: string, worktreeName: string, silent?: boolean): void {
  heartbeatCount++;
  const seq = heartbeatCount;
  const client = createConnection({ path: socketPath }, () => {
    const msg = JSON.stringify({ type: "heartbeat", worktree: worktreeName, seq }) + "\n";
    client.write(msg, () => {
      if (!silent) {
        console.log(`[heartbeat] Sent #${seq} → "${worktreeName}"`);
      }
      client.end();
    });
  });

  client.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      console.warn(`[heartbeat] Daemon not reachable at ${socketPath} — will retry`);
    }
  });

  client.setTimeout(3000, () => {
    client.destroy();
  });
}
