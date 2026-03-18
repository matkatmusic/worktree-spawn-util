# worktree-spawn-util -- Feature Inventory

> This document is a comprehensive requirements specification extracted from all source code in `src/`.
> It is intended to serve as a rebuild guide for reimplementing the project from scratch using the same Node.js/TypeScript approach.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Module Inventory](#2-module-inventory)
3. [CLI Entry Points](#3-cli-entry-points)
4. [Integration Points and Data Flows](#4-integration-points-and-data-flows)
5. [External Dependencies](#5-external-dependencies)
6. [Platform-Specific Behavior](#6-platform-specific-behavior)
7. [Configuration](#7-configuration)
8. [Edge Cases and Error Handling](#8-edge-cases-and-error-handling)
9. [End-to-End Workflows](#9-end-to-end-workflows)
10. [Test Coverage](#10-test-coverage)

---

## 1. Project Overview

**Name:** worktree-spawn-util
**Version:** 0.1.0
**Module type:** ESM (`"type": "module"`)
**Language:** TypeScript (compiled to `dist/`)
**Build:** `tsc` (no bundler)
**Test framework:** Vitest

**Purpose:** A CLI toolkit and library that automates the lifecycle of git worktrees within a multi-agent review orchestration workflow. It creates worktrees, launches IDEs, manages daemon-based heartbeat monitoring, performs conditional cleanup on IDE close, and integrates with tmux for terminal session management.

**Barrel export surface:** `src/index.ts` re-exports all public symbols from 8 submodules:
- `./git.js`
- `./ide.js`
- `./process.js`
- `./config.js`
- `./socket.js`
- `./daemon-server.js`
- `./daemon-client.js`
- `./logger.js`

---

## 2. Module Inventory

### 2.1 `src/git.ts` -- Git Worktree CRUD and Branch Operations

**Imports:** `simple-git`, `node:path`, `node:child_process`, `node:fs/promises`, `node:util`, `./logger.js`

**Constants:**
- `IGNORABLE_PREFIXES = [".claude/", ".vscode/"]` -- file path prefixes considered safe to discard during cleanup evaluation.

**Exported Types:**

| Type | Fields | Purpose |
|---|---|---|
| `WorktreeInfo` | `path: string`, `branch: string` | Represents a created worktree's filesystem path and branch name |
| `RepoSelection` | `repoRoot: string`, `isValid: boolean` | Result of git repo validation |

**Exported Functions:**

| Function | Signature | Behavior |
|---|---|---|
| `getSuperprojectRoot` | `(cwd: string) => Promise<string \| null>` | Detects if `cwd` is inside a git submodule; returns the superproject root path, or `null` if not a submodule. Uses `git rev-parse --show-superproject-working-tree`. |
| `validateRepo` | `(folderPath: string, logger?) => Promise<RepoSelection>` | Validates a folder is a git repo using `simple-git.checkIsRepo()`, resolves the repo root via `rev-parse --show-toplevel`. |
| `parseWorktreeList` | `(raw: string, logger?) => WorktreeInfo[]` | Parses the output of `git worktree list --porcelain` into structured `WorktreeInfo[]`. Splits on double-newlines, extracts `worktree` and `branch refs/heads/` lines. |
| `createWorktree` | `(repoRoot: string, worktreeName: string, logger?) => Promise<WorktreeInfo>` | Creates a worktree at `<repoRoot>/.worktrees/<worktreeName>`. **Idempotent:** returns existing worktree if path+branch match. **Conflict detection:** throws if branch is checked out elsewhere or directory exists but is not a worktree. Reuses existing branches; creates new branches with `-b` flag. Ensures `.worktrees/` directory exists. |
| `isBranchMerged` | `(repoRoot, branch, parentBranch, logger?) => Promise<boolean>` | Checks if `branch` is fully merged into `parentBranch` using `git branch --merged`. Handles the `* `, `+ `, and `  ` prefixes in git output. |
| `hasNewCommits` | `(repoRoot, branch, parentCommit, logger?) => Promise<boolean>` | Checks if `branch` has any commits beyond `parentCommit` using `git log <parentCommit>..<branch> --oneline`. |
| `onlyIgnorableChanges` | `(worktreePath, logger?) => Promise<boolean>` | Checks if all uncommitted changes in a worktree are only in paths prefixed by `IGNORABLE_PREFIXES` (`.claude/`, `.vscode/`). Uses `git status --porcelain`. Returns `true` if no changes or all changes are ignorable. |
| `removeWorktreeAndBranch` | `(repoRoot, worktreeName, logger?) => Promise<void>` | Force-removes a worktree via `git worktree remove --force`, then deletes the branch via `git branch -D`. Branch deletion failure is logged but does not throw. |

---

### 2.2 `src/ide.ts` -- IDE Launcher and VS Code Task Injection

**Imports:** `node:child_process`, `node:fs/promises`, `node:path`, `node:url`, `node:util`, `./socket.js`, `./logger.js`

**Constants:**
- `IDE_BUNDLE_MAP`: Maps macOS bundle identifiers to CLI commands:
  - `"com.microsoft.VSCode"` -> `"code"`
  - `"com.microsoft.VSCodeInsiders"` -> `"code-insiders"`
  - `"com.google.antigravity"` -> `"agy"`

**Exported Types:**

| Type | Fields | Purpose |
|---|---|---|
| `IdeConfig` | `command: string` | Holds the CLI command for the detected IDE |
| `TasksFileStatus` | `"created" \| "updated" \| "unchanged"` | Result of tasks.json write operation |

**Internal Types:**

| Type | Fields | Purpose |
|---|---|---|
| `Task` | `label, type, command, runOptions, presentation, isBackground, problemMatcher` | Shape of a VS Code task entry |
| `TasksJsonFile` | `version: string`, `tasks: Task[]` | Shape of `.vscode/tasks.json` |

**Exported Functions:**

| Function | Signature | Behavior |
|---|---|---|
| `detectIde` | `() => IdeConfig \| null` | Detects the IDE that spawned this process. **Primary:** checks `process.env.__CFBundleIdentifier` against `IDE_BUNDLE_MAP`. **Fallback:** checks `process.env.VSCODE_GIT_ASKPASS_NODE` for path substrings ("Visual Studio Code Insiders", "Visual Studio Code", "Antigravity"). Returns `null` if no IDE detected. |
| `launchIde` | `(config: IdeConfig, worktreePath: string, logger?) => void` | Spawns the IDE as a detached, unref'd process with `worktreePath` as the argument. |
| `writeWorktreeTasksFile` | `(worktreePath, worktreeName, repoRoot?, visible?, logger?) => Promise<TasksFileStatus>` | Ensures `.vscode/tasks.json` exists in the worktree with required tasks. Creates the file if missing, merges into existing. Returns `"created"`, `"updated"`, or `"unchanged"`. |
| `reloadIdeWindow` | `(bundleId: string, logger?) => Promise<void>` | Reloads an IDE window via macOS AppleScript. Activates the app by bundle ID, opens Command Palette (Cmd+Shift+P), types "Reload Window", presses Enter. |
| `notifyUser` | `(title: string, message: string, logger?) => Promise<void>` | Sends a macOS system notification via `osascript display notification`. Best-effort (swallows errors). |

**Internal Functions (task builders):**

| Function | Purpose |
|---|---|
| `addWorktreeSessionTask` | Adds a "Worktree: <name>" task that runs `tmux attach -t <worktreeName>` on folder open. Idempotent (checks label). |
| `addHeartbeatTask` | Adds a "Heartbeat: <name>" task that runs the heartbeat CLI with `--repo-root` and `--worktree` flags. `runOptions.runOn: "folderOpen"`. Visibility controlled by `visible` flag. |
| `addDaemonMonitorTask` | Adds a "Daemon Monitor" task that attaches to the daemon tmux session. Only added when `visible` mode is on. |
| `writeUpdatedTasks` | Writes the tasks.json file to disk with 2-space indentation + trailing newline. |

**Tasks injected into worktree `.vscode/tasks.json`:**

1. **Heartbeat task** -- runs on `folderOpen`, sends heartbeats to daemon via CLI, hidden by default (visible with `--inspectHB`)
2. **Worktree session task** -- runs on `folderOpen`, attaches tmux session for the worktree
3. **Daemon monitor task** -- (optional, visible mode only) attaches to daemon tmux session

---

### 2.3 `src/daemon-server.ts` -- Daemon Server (Heartbeat Monitor + Conditional Cleanup)

**Imports:** `node:net`, `node:fs`, `node:child_process`, `node:path`, `node:util`, `node:events`, `./git.js`, `./ide.js`, `./logger.js`

**Exported Interfaces:**

| Interface | Fields | Purpose |
|---|---|---|
| `DaemonConfig` | `heartbeatTimeoutMs, checkIntervalMs, idleShutdownMs, logger?` | Daemon timing configuration |
| `WorktreeState` | `lastHeartbeat: number, parentBranch: string, parentCommit: string` | Per-worktree tracking state |
| `DaemonHandle` | `server: Server, heartbeats: Map<string, WorktreeState>, events: EventEmitter, shutdown: () => void` | Handle returned by `createDaemonServer` |

**Default Configuration:**
- `heartbeatTimeoutMs`: 15,000 ms (15 seconds)
- `checkIntervalMs`: 5,000 ms (5 seconds)
- `idleShutdownMs`: 60,000 ms (60 seconds)

**Exported Functions:**

| Function | Signature | Behavior |
|---|---|---|
| `createDaemonServer` | `(socketPath, repoRoot, config?) => DaemonHandle` | Creates a Unix domain socket server. Listens for JSON-line messages. Runs a periodic check interval to evaluate heartbeat timeouts, trigger cleanup, and idle shutdown. |

**Events emitted on `handle.events`:**
- `"cleanup"` (worktreeName: string) -- when a worktree heartbeat times out
- `"idle-shutdown"` -- when daemon shuts down due to inactivity
- `"listening"` -- when server is ready
- `"error"` (err) -- on server errors (e.g., EADDRINUSE)

**Message protocol (JSON-line over Unix socket):**

| Message Type | Required Fields | Behavior |
|---|---|---|
| `register` | `type: "register"`, `worktree: string`, `parentBranch: string`, `parentCommit: string` | Registers a worktree with full parent context for conditional cleanup |
| `heartbeat` | `type: "heartbeat"`, `worktree: string`, optional `seq: number` | Updates the `lastHeartbeat` timestamp. If worktree not registered, creates an entry with empty parent info. |

**Conditional Cleanup Logic (when heartbeat times out):**

1. **Always:** Kill tmux session for the worktree name
2. **No parent info:** Force delete worktree and branch (legacy path)
3. **Has parent info:**
   a. Check for uncommitted changes outside `.claude/` and `.vscode/` -> if found, **preserve** and notify user
   b. No new commits beyond parent -> **delete** worktree and branch
   c. Has new commits, check if merged into parent -> if merged, **delete**
   d. Has unmerged commits -> **preserve** and notify user
4. **On error:** Preserve the worktree (safe default)

**Idle shutdown:** If `heartbeats.size === 0` and no activity for `idleShutdownMs`, shuts down and cleans up socket.

---

### 2.4 `src/daemon-client.ts` -- Heartbeat Client

**Imports:** `node:net`, `./logger.js`

**Module state:** `heartbeatCount` counter (incremented per send, used for sequence numbers)

**Exported Functions:**

| Function | Signature | Behavior |
|---|---|---|
| `parseArgs` | `(args: string[]) => { repoRoot: string, worktree: string }` | Parses `--repo-root <path>` and `--worktree <name>` from CLI args array. |
| `sendHeartbeat` | `(socketPath, worktreeName, logger?) => void` | Opens a Unix socket connection, sends a JSON-line heartbeat message with sequence number, then closes. Handles `ENOENT`/`ECONNREFUSED` gracefully (logs warning). 3-second timeout on connection. |

---

### 2.5 `src/socket.ts` -- Unix Domain Socket Utilities

**Imports:** `node:crypto`, `node:fs`, `node:fs/promises`, `node:path`, `node:net`

**Constants:**
- `SOCKET_DIR_PREFIX = "wtsu"`

**Exported Functions:**

| Function | Signature | Behavior |
|---|---|---|
| `getSocketDir` | `() => string` | Returns `/tmp/wtsu-<uid>/` where `<uid>` is `process.getuid()` (defaults to 0). |
| `ensureSocketDir` | `() => string` | Creates the socket directory with `mode 0o700` if it does not exist. Throws if path exists but is not a directory. |
| `getSocketPath` | `(repoRoot: string) => Promise<string>` | Computes a deterministic socket path: resolves `repoRoot` via `realpath`, hashes with SHA-256, truncates to 12 hex chars, returns `/tmp/wtsu-<uid>/<hash>.sock`. |
| `getDaemonSessionName` | `(repoRoot: string) => Promise<string>` | Computes a deterministic tmux session name: `wtsu_daemon_<12-char-hash>`. Same hash strategy as `getSocketPath`. |
| `isSocketAlive` | `(socketPath: string) => Promise<boolean>` | Attempts a TCP connection to the Unix socket. Returns `true` if connected, `false` on error. 2-second timeout. |
| `cleanStaleSocket` | `(socketPath: string) => Promise<boolean>` | Checks if a daemon is alive at the socket. If not, removes the stale socket file. Returns `true` if cleaned (safe to start new daemon), `false` if a live daemon was found. |

---

### 2.6 `src/logger.ts` -- Logger Class

**Imports:** `node:fs/promises`

**Exported Class: `Logger`**

| Member | Type | Behavior |
|---|---|---|
| Constructor | `(filePath?: string, options?: { silent?: boolean })` | Optional file path for persistent logging; optional silent mode suppresses console output |
| `log(message)` | method | Logs to console (unless silent) and appends to file with `[LOG]` prefix and ISO timestamp |
| `warn(message)` | method | Logs to console.warn (unless silent) and appends to file with `[WARN]` prefix |
| `error(message)` | method | Logs to console.error (unless silent) and appends to file with `[ERROR]` prefix |
| `writeToFile` | private method | Appends formatted log line to file. Errors are swallowed (`.catch(() => {})`) |

**Log format:** `[ISO-timestamp] [TYPE] message\n`

---

### 2.7 `src/config.ts` -- Configuration Types

**Exported Types:**

| Type | Fields | Purpose |
|---|---|---|
| `SpawnConfig` | `ideCommand: string`, `pollIntervalMs: number` | Central configuration contract for IDE command and process poll interval |

---

### 2.8 `src/process.ts` -- Process Monitoring Types (Stub)

**Exported Types:**

| Type | Fields | Purpose |
|---|---|---|
| `ProcessHandle` | `pid: number` | Represents a tracked process for IDE window monitoring |

**Status:** Stub only. No monitoring logic implemented. The heartbeat/daemon system serves as the actual process monitoring mechanism.

---

## 3. CLI Entry Points

### 3.1 `src/cli/pick-repo.ts` -- Primary Orchestrator (bin: `wt-pick-repo`)

**The main user-facing command.** Orchestrates the full worktree lifecycle.

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `<name>` | positional string | Yes | Name of the worktree to create |
| `--inspectHB` | flag | No | Show heartbeat and daemon monitor tasks in IDE (visible mode) |
| `--pick` | flag | No | Force the macOS folder picker dialog (skip auto-detection) |

**Behavior (sequential):**

1. **Parse and sanitize** the worktree name (see sanitization rules below)
2. **Auto-detect repo:** If not `--pick`, check if running inside a git submodule via `getSuperprojectRoot(__dirname)`. If found, use superproject as repo root.
3. **Prompt for repo:** If auto-detect fails, show macOS `osascript` folder picker dialog
4. **Validate repo:** Confirm selected folder is a git repository
5. **Capture parent branch info:** Record current branch name and HEAD commit hash (for conditional cleanup later)
6. **Create worktree** at `<repoRoot>/.worktrees/<worktreeName>` via `createWorktree()`
7. **Ensure daemon is running:**
   - Check if daemon socket is alive
   - If not, start daemon in a tmux session (`tmux new-session -d -s <sessionName> <daemonCmd>`)
   - Fallback: if tmux unavailable, spawn daemon as detached child process
   - Poll for socket liveness (max 5 seconds, 100ms intervals)
8. **Register worktree with daemon:** Send a `register` message over Unix socket with `parentBranch` and `parentCommit`
9. **Create tmux session for worktree:**
   - Top pane: `claude --permission-mode plan` (Claude Code agent)
   - Bottom pane: plain terminal shell
   - Auto-selects top pane
   - Waits 3 seconds, then sends `/rename <worktreeName>` to rename Claude conversation
10. **Write `.vscode/tasks.json`** into worktree with heartbeat, tmux attach, and optional daemon monitor tasks
11. **Launch IDE** in worktree (auto-detected from environment)
12. **Prompt for `.gitignore` update:** Asks user if `.worktrees` should be added to `.gitignore` (interactive readline prompt)

**Worktree Name Sanitization Rules:**
- Replace characters invalid in git ref names: ` ~^:?*[]\` -> `_`
- Replace `..` -> `_`
- Replace `@{` -> `_`
- Remove `.lock` suffix
- Remove leading/trailing `.` or `/`
- Collapse consecutive `/` and `_`
- Trim leading/trailing `_`

---

### 3.2 `src/cli/daemon.ts` -- Daemon Entry Point (bin: `wt-daemon`)

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `<repoRoot>` | positional path | Yes | Absolute path to the git repository root |
| `--silent` | flag | No | Suppress console output |
| `--heartbeat-timeout=<ms>` | option | No | Heartbeat timeout (default: 15000) |
| `--check-interval=<ms>` | option | No | Check interval (default: 5000) |

**Behavior:**

1. Parse args
2. Compute socket path for repo
3. Ensure socket directory exists
4. **Stale socket recovery:** Use `cleanStaleSocket()` -- if a live daemon is already running, exit cleanly
5. Create logger with file output at `<socketDir>/daemon.log`
6. Write session header to log file (sync):
   ```
   === SESSION START ===
   worktree: (pending first heartbeat)
   launched: <ISO timestamp>
   repo: <repoRoot>
   socket: <socketPath>
   ========================
   ```
7. Create daemon server via `createDaemonServer()`
8. **Graceful shutdown:** Handle `SIGINT`, `SIGTERM`, and `exit` events -- clean up socket file
9. Listen for `idle-shutdown` event to exit process

---

### 3.3 `src/cli/heartbeat.ts` -- Heartbeat Sender (bin: `wt-heartbeat`)

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `--repo-root <path>` | option | Yes | Repo root path (for socket path computation) |
| `--worktree <name>` | option | Yes | Worktree name to heartbeat for |
| `--silent` | flag | No | Suppress console output |
| `--interval=<ms>` | option | No | Heartbeat interval (default: 5000) |

**Behavior:**

1. Parse args, compute socket path
2. Create logger with file output at `<socketDir>/daemon.log`
3. Send initial heartbeat immediately
4. Set up `setInterval` to send heartbeats at the configured interval
5. Runs indefinitely (designed to be a background VS Code task killed when IDE window closes)

---

### 3.4 `src/cli/spawn.ts` -- Spawn CLI (Stub)

**Status:** Stub implementation only. Parses `<name>` and `--force` from args, logs them, and exits.

**Arguments:**

| Argument | Type | Description |
|---|---|---|
| `<name>` | positional string | Worktree name |
| `--force` | flag | Overwrite existing worktree |

---

### 3.5 `src/cli/install-parent-task.ts` -- VS Code Task Installer (postinstall)

**Purpose:** Detects if `worktree-spawn-util` is a git submodule and installs a VS Code task into the parent repo.

**Behavior:**

1. Detect superproject root via `getSuperprojectRoot(process.cwd())`
2. If not a submodule, skip
3. Read or create `<superprojectRoot>/.vscode/tasks.json`
4. **Idempotency:** Skip if task with label `"Worktree: Pick Repository"` already exists
5. Inject tasks:
   - **Build task:** `npm run build` in the submodule directory, `$tsc` problem matcher
   - **Pick Repository task:** Runs `node <relPath>/dist/cli/pick-repo.js ${input:worktreeName}`, depends on Build task
6. Inject input: `worktreeName` promptString input
7. Write updated `tasks.json`

---

## 4. Integration Points and Data Flows

### 4.1 Module Dependency Graph

```
cli/pick-repo.ts (primary orchestrator)
  |-> git.ts (createWorktree, validateRepo, getSuperprojectRoot)
  |-> ide.ts (detectIde, launchIde, writeWorktreeTasksFile)
  |-> socket.ts (getSocketPath, ensureSocketDir, isSocketAlive, getDaemonSessionName)
  |-> logger.ts (Logger)
  |-> daemon registration (direct socket write)

cli/daemon.ts
  |-> socket.ts (getSocketPath, getSocketDir, ensureSocketDir, cleanStaleSocket)
  |-> daemon-server.ts (createDaemonServer)
  |-> logger.ts (Logger)

cli/heartbeat.ts
  |-> socket.ts (getSocketPath, getSocketDir)
  |-> daemon-client.ts (parseArgs, sendHeartbeat)
  |-> logger.ts (Logger)

cli/install-parent-task.ts
  |-> git.ts (getSuperprojectRoot)

daemon-server.ts
  |-> git.ts (isBranchMerged, hasNewCommits, onlyIgnorableChanges, removeWorktreeAndBranch)
  |-> ide.ts (notifyUser)
  |-> logger.ts (Logger)

ide.ts
  |-> socket.ts (getDaemonSessionName)
  |-> logger.ts (Logger)
```

### 4.2 Socket-Based Communication

- **Transport:** Unix domain sockets at `/tmp/wtsu-<uid>/<sha256-12>.sock`
- **Protocol:** Newline-delimited JSON messages
- **Message types:** `register` (with parent branch/commit context), `heartbeat` (with sequence number)
- **Connection model:** Short-lived per-message connections (connect, write, close)
- **Buffer handling:** Server accumulates data chunks, splits on newline, parses each line as JSON

### 4.3 tmux Integration

- **Daemon session:** Named `wtsu_daemon_<hash>`, runs the daemon CLI
- **Worktree session:** Named `<worktreeName>`, contains:
  - Pane 0: Claude Code in plan mode
  - Pane 1: Plain terminal shell
- **Fallback:** If tmux is unavailable, daemon spawns as detached child process

---

## 5. External Dependencies

### 5.1 Runtime Dependencies

| Package | Version | Purpose |
|---|---|---|
| `simple-git` | `^3.27.0` | Git operations (worktree CRUD, branch management, repo validation) |

### 5.2 Node.js Built-in Modules Used

| Module | Used By | Purpose |
|---|---|---|
| `node:child_process` | git.ts, ide.ts, daemon-server.ts, pick-repo.ts | `execFile` for git/osascript/tmux commands; `spawn` for IDE launch and daemon fallback |
| `node:net` | socket.ts, daemon-server.ts, daemon-client.ts, pick-repo.ts | Unix domain socket server/client |
| `node:fs` | socket.ts, daemon-server.ts, cli/daemon.ts | Sync filesystem ops (mkdirSync, unlinkSync, statSync, appendFileSync) |
| `node:fs/promises` | git.ts, ide.ts, logger.ts, pick-repo.ts, install-parent-task.ts | Async filesystem ops (readFile, writeFile, mkdir, appendFile, access, realpath) |
| `node:crypto` | socket.ts | SHA-256 hashing for deterministic socket/session names |
| `node:path` | Most modules | Path manipulation (join, dirname, relative) |
| `node:url` | ide.ts, pick-repo.ts | `fileURLToPath` for ESM `__dirname` equivalent |
| `node:util` | git.ts, ide.ts, daemon-server.ts, pick-repo.ts | `promisify` for callback-based APIs |
| `node:events` | daemon-server.ts | `EventEmitter` for daemon lifecycle events |
| `node:readline/promises` | pick-repo.ts | Interactive user prompts |

### 5.3 Dev Dependencies

| Package | Version | Purpose |
|---|---|---|
| `typescript` | `^5.8.2` | TypeScript compiler |
| `@types/node` | `^22.13.10` | Node.js type definitions |
| `vitest` | `^3.0.9` | Test runner |

---

## 6. Platform-Specific Behavior

This project is **macOS-specific** in several areas:

| Feature | macOS API | Fallback |
|---|---|---|
| IDE detection | `process.env.__CFBundleIdentifier` | `VSCODE_GIT_ASKPASS_NODE` path inspection |
| Folder picker | `osascript -e 'choose folder'` | None (process exits if no folder selected) |
| IDE window reload | AppleScript: activate by bundle ID, System Events keystrokes | Logs manual instruction |
| System notifications | `osascript display notification` | Silent failure |
| Socket directory | `/tmp/wtsu-<uid>/` with `process.getuid()` | Defaults uid to 0 |

---

## 7. Configuration

### 7.1 Type-Level Configuration

| Config Type | Field | Default | Used By |
|---|---|---|---|
| `SpawnConfig` | `ideCommand` | (not set) | IDE module |
| `SpawnConfig` | `pollIntervalMs` | (not set) | Process module |
| `DaemonConfig` | `heartbeatTimeoutMs` | 15,000 ms | Daemon server |
| `DaemonConfig` | `checkIntervalMs` | 5,000 ms | Daemon server |
| `DaemonConfig` | `idleShutdownMs` | 60,000 ms | Daemon server |

### 7.2 CLI-Level Configuration

| CLI | Flag/Option | Default |
|---|---|---|
| `wt-heartbeat` | `--interval=<ms>` | 5000 |
| `wt-daemon` | `--heartbeat-timeout=<ms>` | 15000 |
| `wt-daemon` | `--check-interval=<ms>` | 5000 |

### 7.3 Environment Variables Read

| Variable | Read By | Purpose |
|---|---|---|
| `__CFBundleIdentifier` | `ide.ts` | macOS bundle ID of the launching app |
| `VSCODE_GIT_ASKPASS_NODE` | `ide.ts` | Path to the VS Code/fork Node.js binary |

### 7.4 Filesystem Paths

| Path | Purpose |
|---|---|
| `/tmp/wtsu-<uid>/` | Socket directory (per-user, mode 0700) |
| `/tmp/wtsu-<uid>/<hash>.sock` | Per-repo daemon socket |
| `/tmp/wtsu-<uid>/daemon.log` | Shared daemon log file |
| `<repoRoot>/.worktrees/<name>/` | Worktree directories |
| `<worktreePath>/.vscode/tasks.json` | Auto-generated IDE tasks |
| `<superprojectRoot>/.vscode/tasks.json` | Installed parent repo tasks |

### 7.5 Package.json `bin` Entries

| Binary Name | Script Path |
|---|---|
| `wt-pick-repo` | `dist/cli/pick-repo.js` |
| `wt-daemon` | `dist/cli/daemon.js` |
| `wt-heartbeat` | `dist/cli/heartbeat.js` |

---

## 8. Edge Cases and Error Handling

### 8.1 Idempotency

| Operation | Idempotency Behavior |
|---|---|
| `createWorktree` | If worktree exists with matching path+branch, returns it without modification |
| `writeWorktreeTasksFile` | Checks task labels before adding; returns `"unchanged"` if all tasks already exist |
| `install-parent-task.ts` | Checks for existing task label before injection |
| `addWorktreeSessionTask` | Checks label uniqueness |
| `addHeartbeatTask` | Checks label uniqueness |
| `addDaemonMonitorTask` | Checks label uniqueness |
| Daemon startup | `cleanStaleSocket` prevents duplicate daemons; exits cleanly if one is already running |

### 8.2 Conflict Detection

| Scenario | Behavior |
|---|---|
| Branch checked out in another worktree | `createWorktree` throws with descriptive error |
| Directory exists but is not a worktree | `createWorktree` throws with descriptive error |
| Socket already in use (EADDRINUSE) | Daemon logs error and emits `"error"` event |

### 8.3 Error Handling Patterns

| Pattern | Where Used |
|---|---|
| Graceful daemon connection failure | `sendHeartbeat` handles `ENOENT`/`ECONNREFUSED` with warning log |
| Socket timeout | Client connections use 2-3 second timeouts |
| File-not-found tolerance | Tasks.json reading, .gitignore reading, branch deletion all catch and continue |
| Malformed message tolerance | Daemon server wraps JSON.parse in try/catch, ignores bad messages |
| Cleanup-on-error preservation | Daemon preserves worktree if cleanup evaluation throws |
| Signal handling | Daemon handles SIGINT, SIGTERM, and exit for socket cleanup |
| Best-effort notification | `notifyUser` swallows all errors |
| Best-effort logging | `Logger.writeToFile` catches and ignores append errors |

### 8.4 Worktree Name Sanitization

The `sanitizeWorktreeName` function in `pick-repo.ts` handles:
- Characters invalid in git ref names (space, tilde, caret, colon, question mark, asterisk, brackets, backslash)
- Double dots (`..`)
- Reflog syntax (`@{`)
- `.lock` suffix
- Leading/trailing dots and slashes
- Consecutive slashes and underscores

---

## 9. End-to-End Workflows

### 9.1 Full Session Lifecycle

```
User invokes "wt-pick-repo <name>" (or VS Code task)
  |
  v
[1] Sanitize worktree name
  |
  v
[2] Auto-detect repo (submodule) or show macOS folder picker
  |
  v
[3] Validate selected folder is a git repo
  |
  v
[4] Record parent branch + HEAD commit
  |
  v
[5] Create worktree at <repoRoot>/.worktrees/<name>
    (idempotent -- reuses if exists)
  |
  v
[6] Check if daemon socket is alive
    |-- Yes: skip to step 7
    |-- No:  start daemon in tmux session (or detached process)
    |        poll socket for up to 5 seconds
  |
  v
[7] Register worktree with daemon (send parentBranch + parentCommit)
  |
  v
[8] Create tmux session:
    Pane 0: claude --permission-mode plan
    Pane 1: terminal shell
    Wait 3s, send /rename <name>
  |
  v
[9] Write .vscode/tasks.json into worktree:
    - Heartbeat task (runs on folderOpen)
    - Worktree session task (tmux attach)
    - Daemon monitor task (optional, --inspectHB)
  |
  v
[10] Launch detected IDE at worktree path
  |
  v
[11] Prompt to add .worktrees to .gitignore
```

### 9.2 Heartbeat and Cleanup Flow

```
IDE window opens worktree
  |
  v
VS Code runs "folderOpen" tasks from .vscode/tasks.json
  |
  v
Heartbeat task starts -> sends heartbeats every 5s to daemon socket
  |
  v
Daemon receives heartbeats, updates lastHeartbeat timestamp
  |
  ...
  |
  v
IDE window closes -> heartbeat task is killed by IDE
  |
  v
Daemon check interval detects heartbeat timeout (>15s since last)
  |
  v
[1] Kill tmux session for worktree
  |
  v
[2] Evaluate cleanup:
    a. Uncommitted non-ignorable changes? -> PRESERVE + notify
    b. No new commits since parent? -> DELETE worktree + branch
    c. New commits, merged into parent? -> DELETE worktree + branch
    d. New commits, NOT merged? -> PRESERVE + notify
  |
  v
[3] If all worktrees cleaned and idle for 60s -> daemon self-shutdown
```

### 9.3 Submodule Installation Flow

```
npm install (in parent project with worktree-spawn-util as submodule)
  |
  v
postinstall script runs install-parent-task.ts
  |
  v
Detects superproject root via getSuperprojectRoot
  |
  v
Reads/creates <superproject>/.vscode/tasks.json
  |
  v
Injects "Build (worktree-spawn-util)" task
Injects "Worktree: Pick Repository" task (with input prompt)
  |
  v
User can now run the task from VS Code Command Palette
```

---

## 10. Test Coverage

**Test files present:**

| File | Module Tested |
|---|---|
| `test/smoke.test.ts` | Barrel export loads without errors |
| `test/git.test.ts` | Git worktree operations |
| `test/ide.test.ts` | IDE detection and tasks.json writing |
| `test/daemon.test.ts` | Daemon server lifecycle |
| `test/heartbeat.test.ts` | Heartbeat client |
| `test/socket.test.ts` | Socket path utilities |
| `test/cleanup-logic.test.ts` | Conditional cleanup decision logic |

---

## Appendix: File Manifest

| File | Status | Lines | Purpose |
|---|---|---|---|
| `src/index.ts` | Complete | 12 | Barrel export |
| `src/git.ts` | Complete | 209 | Git worktree CRUD, branch ops, merge detection |
| `src/ide.ts` | Complete | 252 | IDE detection, launch, tasks.json management, AppleScript integration |
| `src/daemon-server.ts` | Complete | 219 | Daemon server with heartbeat monitoring and conditional cleanup |
| `src/daemon-client.ts` | Complete | 47 | Heartbeat client (send over Unix socket) |
| `src/socket.ts` | Complete | 93 | Unix socket path utilities and liveness checks |
| `src/logger.ts` | Complete | 36 | Logger class with file + console output |
| `src/config.ts` | Complete | 6 | SpawnConfig type definition |
| `src/process.ts` | Stub | 5 | ProcessHandle type only |
| `src/cli/pick-repo.ts` | Complete | 245 | Primary orchestrator CLI |
| `src/cli/daemon.ts` | Complete | 79 | Daemon CLI wrapper |
| `src/cli/heartbeat.ts` | Complete | 25 | Heartbeat CLI wrapper |
| `src/cli/spawn.ts` | Stub | 11 | Unused spawn CLI stub |
| `src/cli/install-parent-task.ts` | Complete | 103 | VS Code task installer for parent repos |
