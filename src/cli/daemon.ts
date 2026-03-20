#!/usr/bin/env node

// daemon CLI — thin wrapper around daemon/server.ts

import { appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getSocketPath, getSocketDir, ensureSocketDir, cleanStaleSocket } from "../socket.js";
import { createDaemonServer } from "../daemon-server.js";
import { Logger } from "../logger.js";
import { DAEMON_FLAG_SILENT, DAEMON_FLAG_HEARTBEAT_TIMEOUT, DAEMON_FLAG_CHECK_INTERVAL } from "../cli-flags.js";

const args = process.argv.slice(2);
const silent = args.includes(DAEMON_FLAG_SILENT);
const heartbeatTimeoutMs = parseInt(args.find((a) => a.startsWith(DAEMON_FLAG_HEARTBEAT_TIMEOUT + "="))?.split("=")[1] ?? "15000");
const checkIntervalMs = parseInt(args.find((a) => a.startsWith(DAEMON_FLAG_CHECK_INTERVAL + "="))?.split("=")[1] ?? "5000");
const repoRoot = args.find((a) => !a.startsWith("--"));

// Early logger (no file path yet — just console output for early-exit messages)
const earlyLogger = new Logger();

if (!repoRoot) {
  earlyLogger.error("[daemon] Usage: daemon [--silent] [--heartbeat-timeout=ms] [--check-interval=ms] <repoRoot>");
  process.exit(1);
}

const socketPath = await getSocketPath(repoRoot);
ensureSocketDir();

// --- Stale socket recovery ---
const cleaned = await cleanStaleSocket(socketPath);
if (!cleaned) {
  earlyLogger.log("[daemon] Another daemon is already running for this repo.");
  process.exit(0);
}

// --- Start server ---
const logFile = join(getSocketDir(), "daemon.log");
const logger = new Logger(logFile, { silent });

// Write session header (sync, runs once at startup)
try {
  appendFileSync(logFile,
    `\n=== SESSION START ===\n` +
    `worktree: (pending first heartbeat)\n` +
    `launched: ${new Date().toISOString()}\n` +
    `repo: ${repoRoot}\n` +
    `socket: ${socketPath}\n` +
    `========================\n`,
  );
} catch {
  // Best effort
}

const handle = createDaemonServer(socketPath, repoRoot, { logger, heartbeatTimeoutMs, checkIntervalMs });
logger.log(`[daemon] Watching repo: ${repoRoot}`);

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
