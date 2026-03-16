#!/usr/bin/env node

// heartbeat CLI — thin wrapper around heartbeat/client.ts

import { join } from "node:path";
import { getSocketPath, getSocketDir } from "../socket.js";
import { parseArgs, sendHeartbeat } from "../daemon-client.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

const allArgs = process.argv.slice(2);
const silent = allArgs.includes("--silent");
const filteredArgs = allArgs.filter((a) => a !== "--silent");
const { repoRoot, worktree } = parseArgs(filteredArgs);

if (!repoRoot || !worktree) {
  console.error("[heartbeat] Usage: heartbeat [--silent] --repo-root <path> --worktree <name>");
  process.exit(1);
}

const socketPath = await getSocketPath(repoRoot);

const logFile = join(getSocketDir(), "daemon.log");

console.log(`[heartbeat] Starting for worktree "${worktree}" → ${socketPath}`);
sendHeartbeat(socketPath, worktree, silent, logFile);
setInterval(() => sendHeartbeat(socketPath, worktree, silent, logFile), HEARTBEAT_INTERVAL_MS);
