#!/usr/bin/env node

// heartbeat CLI — thin wrapper around heartbeat/client.ts

import { getSocketPath } from "../socket/index.js";
import { parseArgs, sendHeartbeat } from "../heartbeat/client.js";

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

console.log(`[heartbeat] Starting for worktree "${worktree}" → ${socketPath}`);
sendHeartbeat(socketPath, worktree, silent);
setInterval(() => sendHeartbeat(socketPath, worktree, silent), HEARTBEAT_INTERVAL_MS);
