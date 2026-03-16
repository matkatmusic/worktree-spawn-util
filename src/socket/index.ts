// socket module — Unix domain socket path utilities and liveness checks

import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";

const SOCKET_DIR_PREFIX = "wtsu";

/** Get the per-user socket directory: /tmp/wtsu-<uid>/ */
export function getSocketDir(): string {
  const uid = process.getuid?.() ?? 0;
  return join("/tmp", `${SOCKET_DIR_PREFIX}-${uid}`);
}

/** Ensure the socket directory exists with restrictive permissions. */
export function ensureSocketDir(): string {
  const dir = getSocketDir();
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`${dir} exists but is not a directory`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dir, { mode: 0o700, recursive: true });
    } else {
      throw err;
    }
  }
  return dir;
}

/**
 * Compute the deterministic socket path for a repo root.
 * Uses sha256 of the resolved real path, truncated to 12 hex chars.
 */
export async function getSocketPath(repoRoot: string): Promise<string> {
  const resolved = await realpath(repoRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return join(getSocketDir(), `${hash}.sock`);
}

/**
 * Compute a deterministic, tmux-safe daemon session name for a repo root.
 * Uses the same sha256 + realpath strategy as getSocketPath().
 */
export async function getDaemonSessionName(repoRoot: string): Promise<string> {
  const resolved = await realpath(repoRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `wtsu_daemon_${hash}`;
}

/**
 * Check if a daemon is alive at the given socket path.
 * Attempts a TCP connection; resolves true if connected, false on ECONNREFUSED or ENOENT.
 */
export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection({ path: socketPath }, () => {
      client.end();
      resolve(true);
    });
    client.on("error", () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Remove a stale socket file, but only after confirming no daemon is listening.
 * Returns true if the socket was removed, false if a live daemon was found.
 */
export async function cleanStaleSocket(socketPath: string): Promise<boolean> {
  const alive = await isSocketAlive(socketPath);
  if (alive) {
    return false;
  }
  try {
    unlinkSync(socketPath);
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
  }
  return true;
}
