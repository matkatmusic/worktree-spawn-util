#!/usr/bin/env node

// heartbeat CLI — thin wrapper around heartbeat/client.ts

import { join } from "node:path";
import { getSocketPath, getSocketDir } from "../socket.js";
import { parseArgs, sendHeartbeat } from "../daemon-client.js";
import { Logger } from "../logger.js";
import { DAEMON_FLAG_SILENT, HEARTBEAT_FLAG_INTERVAL } from "../cli-flags.js";

const allArgs = process.argv.slice(2);
const silent = allArgs.includes(DAEMON_FLAG_SILENT);
const intervalArg = allArgs.find((a) => a.startsWith(HEARTBEAT_FLAG_INTERVAL + "="));
const HEARTBEAT_INTERVAL_MS = parseInt(intervalArg?.split("=")[1] ?? "5000");
const filteredArgs = allArgs.filter((a) => a !== DAEMON_FLAG_SILENT && !a.startsWith(HEARTBEAT_FLAG_INTERVAL + "="));
const { repoRoot, worktree } = parseArgs(filteredArgs);

if (!repoRoot || !worktree) {
  new Logger().error("[heartbeat] Usage: heartbeat [--silent] --repo-root <path> --worktree <name>");
  process.exit(1);
}

const socketPath = await getSocketPath(repoRoot);

const logFile = join(getSocketDir(), "daemon.log");
const logger = new Logger(logFile, { silent });

logger.log(`[heartbeat] Starting for worktree "${worktree}" -> ${socketPath}`);
sendHeartbeat(socketPath, worktree, logger);
setInterval(() => sendHeartbeat(socketPath, worktree, logger), HEARTBEAT_INTERVAL_MS);
