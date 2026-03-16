#!/usr/bin/env node

// daemon CLI — thin wrapper around daemon/server.ts

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSocketPath, getSocketDir, ensureSocketDir, cleanStaleSocket } from "../socket/index.js";
import { createDaemonServer } from "../daemon/server.js";

const args = process.argv.slice(2);
const silent = args.includes("--silent");
const repoRoot = args.find((a) => a !== "--silent");

if (!repoRoot) {
  console.error("[daemon] Usage: daemon [--silent] <repoRoot>");
  process.exit(1);
}

const socketPath = await getSocketPath(repoRoot);
ensureSocketDir();

// --- Stale socket recovery ---
const cleaned = await cleanStaleSocket(socketPath);
if (!cleaned) {
  console.log("[daemon] Another daemon is already running for this repo.");
  process.exit(0);
}

// --- Start server ---
const logFile = join(getSocketDir(), "daemon.log");
const handle = createDaemonServer(socketPath, repoRoot, { silent, logFile });
console.log(`[daemon] Watching repo: ${repoRoot}`);

// --- Graceful shutdown ---
function cleanupAndExit(): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // Best effort
  }
  process.exit(0);
}

handle.events.on("idle-shutdown", () => {
  process.exit(0);
});

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);
process.on("exit", () => {
  try {
    unlinkSync(socketPath);
  } catch {
    // Best effort on exit
  }
});
