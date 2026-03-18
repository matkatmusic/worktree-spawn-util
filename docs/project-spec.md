# worktree-spawn-util — Project Specification

> A CLI toolkit for automating the lifecycle of git worktrees within a multi-agent code review workflow. Creates worktrees, launches IDEs, manages background daemon monitoring, and performs conditional cleanup when IDE windows close.

---

## 1. Goals

1. **One-command worktree setup**: User provides a name → tool creates a git worktree, launches an IDE, starts a Claude Code agent in tmux, and wires up background monitoring.
2. **Automatic cleanup**: When the IDE window closes, evaluate whether the worktree's work is complete (merged, no changes) and clean up automatically — or preserve it and notify the user.
3. **Submodule-aware**: When installed as a git submodule, auto-detect the parent repo and inject VS Code tasks for seamless integration.
4. **Idempotent and safe**: Every operation is idempotent. Worktrees with unmerged commits or uncommitted changes are never deleted.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  pick-repo (CLI orchestrator)                       │
│  Creates worktree, starts daemon, registers,        │
│  launches IDE + tmux session                        │
└────────┬──────────┬──────────┬──────────────────────┘
         │          │          │
         v          v          v
┌────────────┐ ┌─────────┐ ┌──────────────────────┐
│  git.ts    │ │  ide.ts │ │  socket.ts           │
│  Worktree  │ │  IDE    │ │  Unix socket paths,  │
│  CRUD,     │ │  detect,│ │  liveness checks,    │
│  merge     │ │  launch,│ │  session names       │
│  detection │ │  tasks  │ │                      │
└────────────┘ └─────────┘ └──────────┬───────────┘
                                      │
         ┌────────────────────────────┤
         │                            │
         v                            v
┌─────────────────┐    ┌──────────────────────────┐
│  daemon-server  │◄───│  daemon-client           │
│  Heartbeat      │    │  (heartbeat.ts CLI)      │
│  monitor +      │    │  Sends heartbeats over   │
│  conditional    │    │  Unix socket every 5s    │
│  cleanup        │    └──────────────────────────┘
└─────────────────┘
         │
         v
  Cleanup Decision Tree
  (merge/commit/change analysis)
```

### Process Model

- **pick-repo**: Short-lived CLI. Orchestrates setup, then exits.
- **daemon**: Long-lived background process (one per repo). Monitors heartbeats, performs cleanup, self-terminates when idle.
- **heartbeat**: Long-lived background process (one per worktree). Runs as a VS Code task, killed when IDE window closes.

### Communication

- **Transport**: Unix domain sockets at `/tmp/wtsu-<uid>/<sha256-12>.sock`
- **Protocol**: Newline-delimited JSON messages over short-lived connections
- **Message types**: `register` (with parent branch/commit), `heartbeat` (with sequence number)

---

## 3. Modules

### 3.1 git — Worktree CRUD and Branch Operations

**File**: `src/git.ts`
**Dependency**: `simple-git`

| Requirement | Description |
|---|---|
| R-GIT-01 | Detect if cwd is inside a git submodule; return superproject root or null |
| R-GIT-02 | Validate a folder is a git repo; resolve to the repo root |
| R-GIT-03 | Parse `git worktree list --porcelain` output into structured data |
| R-GIT-04 | Create a worktree at `<repoRoot>/.worktrees/<name>`. Must be idempotent (return existing if path+branch match). Must detect branch conflicts (checked out elsewhere) and directory conflicts (exists but not a worktree). Reuse existing branches; create new ones with `-b` flag. |
| R-GIT-05 | Check if a branch is fully merged into a parent branch |
| R-GIT-06 | Check if a branch has commits beyond a given parent commit |
| R-GIT-07 | Check if all uncommitted changes in a worktree are in ignorable paths (`.claude/`, `.vscode/`) |
| R-GIT-08 | Force-remove a worktree and delete its branch. Branch deletion failure must be logged but not thrown. |

### 3.2 ide — IDE Detection, Launch, and Task Injection

**File**: `src/ide.ts`

| Requirement | Description |
|---|---|
| R-IDE-01 | Detect the IDE that spawned the process. Primary: macOS `__CFBundleIdentifier` env var mapped to CLI commands (`code`, `code-insiders`, `agy`). Fallback: `VSCODE_GIT_ASKPASS_NODE` path inspection. |
| R-IDE-02 | Launch an IDE as a detached process at a given worktree path |
| R-IDE-03 | Write `.vscode/tasks.json` into a worktree with: heartbeat task (runs on folderOpen), tmux attach task (runs on folderOpen), optional daemon monitor task (visible mode only). Must merge into existing tasks.json. Must be idempotent (check labels before adding). Return status: `created`, `updated`, or `unchanged`. |
| R-IDE-04 | Reload an IDE window via macOS AppleScript (activate app, Command Palette, "Reload Window") |
| R-IDE-05 | Send macOS system notifications via osascript. Best-effort (swallow errors). |

### 3.3 daemon-server — Heartbeat Monitor and Conditional Cleanup

**File**: `src/daemon-server.ts`

| Requirement | Description |
|---|---|
| R-DAEMON-01 | Create a Unix domain socket server that listens for JSON-line messages |
| R-DAEMON-02 | Accept `register` messages: store worktree name, parent branch, and parent commit |
| R-DAEMON-03 | Accept `heartbeat` messages: update last-seen timestamp. If worktree not registered, create entry with empty parent info. |
| R-DAEMON-04 | Run periodic check interval to detect heartbeat timeouts |
| R-DAEMON-05 | **Conditional cleanup** when heartbeat times out (decision tree): (1) Kill tmux session. (2) If no parent info: force delete. (3) If uncommitted non-ignorable changes: preserve + notify. (4) If no new commits since parent: delete. (5) If new commits and merged: delete. (6) If new commits and not merged: preserve + notify. (7) On error: preserve (safe default). |
| R-DAEMON-06 | Self-shutdown after `idleShutdownMs` with no registered worktrees. Clean up socket file. |
| R-DAEMON-07 | Emit events: `cleanup`, `idle-shutdown`, `listening`, `error` |

**Default Timing**:
- Heartbeat timeout: 15,000 ms
- Check interval: 5,000 ms
- Idle shutdown: 60,000 ms

### 3.4 daemon-client — Heartbeat Sender

**File**: `src/daemon-client.ts`

| Requirement | Description |
|---|---|
| R-CLIENT-01 | Parse `--repo-root` and `--worktree` from CLI args |
| R-CLIENT-02 | Send a heartbeat message over Unix socket with sequence number. Handle `ENOENT`/`ECONNREFUSED` gracefully (log warning). 3-second connection timeout. |

### 3.5 socket — Unix Domain Socket Utilities

**File**: `src/socket.ts`

| Requirement | Description |
|---|---|
| R-SOCK-01 | Compute socket directory: `/tmp/wtsu-<uid>/` |
| R-SOCK-02 | Create socket directory with mode `0o700`. Throw if path exists but is not a directory. |
| R-SOCK-03 | Compute deterministic socket path: SHA-256 hash of `realpath(repoRoot)`, truncated to 12 hex chars, with `.sock` extension |
| R-SOCK-04 | Compute deterministic tmux session name: `wtsu_daemon_<12-char-hash>` (same hash strategy) |
| R-SOCK-05 | Check if a daemon is alive at a socket path (2-second timeout TCP connection) |
| R-SOCK-06 | Clean stale sockets: if daemon not alive, remove socket file. Return whether it's safe to start a new daemon. |

### 3.6 logger — Structured Logging

**File**: `src/logger.ts`

| Requirement | Description |
|---|---|
| R-LOG-01 | Logger class with optional file path and optional silent mode |
| R-LOG-02 | Methods: `log`, `warn`, `error` — write to console (unless silent) and append to file |
| R-LOG-03 | Format: `[ISO-timestamp] [TYPE] message\n` |
| R-LOG-04 | File write errors must be swallowed silently |

### 3.7 config — Configuration Types

**File**: `src/config.ts`

| Requirement | Description |
|---|---|
| R-CFG-01 | `SpawnConfig` type: `ideCommand: string`, `pollIntervalMs: number` |

### 3.8 process — Process Monitoring Types (Stub)

**File**: `src/process.ts`

| Requirement | Description |
|---|---|
| R-PROC-01 | `ProcessHandle` type: `pid: number`. Stub only — heartbeat system serves as the actual monitoring mechanism. |

---

## 4. CLI Entry Points

### 4.1 wt-pick-repo — Primary Orchestrator

**File**: `src/cli/pick-repo.ts`
**Bin**: `wt-pick-repo`

**Arguments**:

| Argument | Type | Required | Description |
|---|---|---|---|
| `<name>` | positional | Yes | Worktree name (sanitized before use) |
| `--inspectHB` | flag | No | Show heartbeat/daemon tasks in IDE |
| `--pick` | flag | No | Force macOS folder picker (skip submodule auto-detect) |

**Behavior** (sequential):

1. Parse and sanitize worktree name
2. Auto-detect repo: check for submodule via `getSuperprojectRoot(__dirname)`, use superproject root if found
3. If no auto-detect: show macOS `osascript` folder picker
4. Validate folder is a git repo
5. Capture current branch name and HEAD commit
6. Create worktree at `<repoRoot>/.worktrees/<name>`
7. Ensure daemon is running: check socket → start in tmux (fallback: detached process) → poll up to 5s
8. Register worktree with daemon (send parent branch + commit over socket)
9. Create tmux session: top pane = `claude --permission-mode plan`, bottom pane = shell. Wait 3s, send `/rename <name>`
10. Write `.vscode/tasks.json` into worktree
11. Launch detected IDE at worktree path
12. Prompt to add `.worktrees` to `.gitignore`

**Name Sanitization Rules**:
- Replace invalid git ref chars (`space ~^:?*[]\`) → `_`
- Replace `..` → `_`, `@{` → `_`
- Remove `.lock` suffix
- Remove leading/trailing `.` or `/`
- Collapse consecutive `/` and `_`
- Trim leading/trailing `_`

### 4.2 wt-daemon — Daemon Entry Point

**File**: `src/cli/daemon.ts`
**Bin**: `wt-daemon`

| Argument | Type | Required | Description |
|---|---|---|---|
| `<repoRoot>` | positional | Yes | Absolute path to git repo root |
| `--silent` | flag | No | Suppress console output |
| `--heartbeat-timeout=<ms>` | option | No | Default: 15000 |
| `--check-interval=<ms>` | option | No | Default: 5000 |

**Behavior**:
1. Compute socket path, ensure socket directory
2. Stale socket recovery via `cleanStaleSocket()` — exit if live daemon exists
3. Create logger with file at `<socketDir>/daemon.log`
4. Write session header to log
5. Create daemon server
6. Handle `SIGINT`, `SIGTERM`, `exit` — clean up socket file
7. Exit on `idle-shutdown` event

### 4.3 wt-heartbeat — Heartbeat Sender

**File**: `src/cli/heartbeat.ts`
**Bin**: `wt-heartbeat`

| Argument | Type | Required | Description |
|---|---|---|---|
| `--repo-root <path>` | option | Yes | Repo root for socket path |
| `--worktree <name>` | option | Yes | Worktree name |
| `--silent` | flag | No | Suppress console output |
| `--interval=<ms>` | option | No | Default: 5000 |

**Behavior**: Send initial heartbeat, then repeat at interval. Runs indefinitely (killed by IDE on window close).

### 4.4 install-parent-task — VS Code Task Installer

**File**: `src/cli/install-parent-task.ts`

**Behavior**:
1. Detect superproject root via `getSuperprojectRoot(process.cwd())`
2. If not a submodule → exit 0
3. Compute relative path from superproject to submodule
4. Read or create `<superproject>/.vscode/tasks.json`
5. Idempotency: skip if "Worktree: Pick Repository" task exists
6. Inject "Build (worktree-spawn-util)" task (with `cwd` pointing to submodule)
7. Inject "Worktree: Pick Repository" task (depends on Build, uses `${workspaceFolder}/<relPath>`)
8. Inject `worktreeName` promptString input
9. Write updated JSON

---

## 5. End-to-End Workflows

### 5.1 Session Lifecycle

```
User runs "wt-pick-repo <name>"
  → Sanitize name
  → Detect repo (submodule auto-detect or folder picker)
  → Validate git repo
  → Record parent branch + commit
  → Create worktree
  → Start daemon (if not running)
  → Register worktree with daemon
  → Create tmux session (Claude + terminal)
  → Write .vscode/tasks.json
  → Launch IDE
  → Prompt for .gitignore update
```

### 5.2 Heartbeat and Cleanup

```
IDE opens worktree
  → VS Code folderOpen tasks start heartbeat process
  → Heartbeat sends every 5s to daemon socket
  → ...
IDE window closes
  → Heartbeat process killed
  → Daemon detects timeout (>15s)
  → Kill tmux session
  → Evaluate cleanup:
      Uncommitted changes? → PRESERVE + notify
      No new commits?      → DELETE
      Merged?              → DELETE
      Unmerged?            → PRESERVE + notify
  → If all worktrees gone + idle 60s → daemon self-shutdown
```

### 5.3 Submodule Installation

```
User adds worktree-spawn-util as git submodule
  → Runs RunMeFirst.sh from submodule
  → npm install → npm run build
  → node install-parent-task.js
  → Detects superproject, injects VS Code tasks into parent
  → User runs "Worktree: Pick Repository" from VS Code
```

---

## 6. Platform Requirements

| Requirement | Detail |
|---|---|
| **OS** | macOS (osascript, bundle IDs, System Events) |
| **Runtime** | Node.js (ESM, `"type": "module"`) |
| **Language** | TypeScript, compiled with `tsc` |
| **Build** | `tsc` (no bundler) |
| **Test** | Vitest |
| **Dependencies** | `simple-git` (runtime), `typescript`, `@types/node`, `vitest` (dev) |
| **External tools** | tmux (optional, fallback to detached process), git, VS Code / Cursor / AGY |

---

## 7. Cross-Cutting Concerns

### 7.1 Idempotency

Every operation that creates or modifies state must be idempotent:
- Worktree creation returns existing if path+branch match
- Task injection checks labels before adding
- Parent task installer checks for existing task
- Daemon startup checks for live daemon before starting

### 7.2 Error Handling

- **Safe defaults**: On cleanup evaluation error, preserve the worktree
- **Graceful degradation**: Socket connection failures log warnings, don't crash
- **Best-effort side effects**: Notifications, file logging, branch deletion — all swallow errors
- **Malformed input tolerance**: Daemon ignores unparseable JSON messages

### 7.3 Signal Handling

Daemon must handle `SIGINT`, `SIGTERM`, and `exit` to clean up the socket file.

### 7.4 Logging

All modules accept an optional `Logger` instance. Log to console + file with ISO timestamps and level prefixes.

---

## 8. File Manifest

| File | Status | Purpose |
|---|---|---|
| `src/index.ts` | Required | Barrel export for all public API |
| `src/git.ts` | Required | Git worktree CRUD, branch ops, merge detection |
| `src/ide.ts` | Required | IDE detection, launch, tasks.json management |
| `src/daemon-server.ts` | Required | Daemon server with heartbeat monitoring and cleanup |
| `src/daemon-client.ts` | Required | Heartbeat client |
| `src/socket.ts` | Required | Unix socket utilities |
| `src/logger.ts` | Required | Logger class |
| `src/config.ts` | Required | SpawnConfig type |
| `src/process.ts` | Optional | ProcessHandle stub (superseded by heartbeat system) |
| `src/cli/pick-repo.ts` | Required | Primary orchestrator CLI |
| `src/cli/daemon.ts` | Required | Daemon CLI wrapper |
| `src/cli/heartbeat.ts` | Required | Heartbeat CLI wrapper |
| `src/cli/spawn.ts` | Optional | Unused stub |
| `src/cli/install-parent-task.ts` | Required | Parent repo task installer |
| `RunMeFirst.sh` | Required | First-time setup script |

---

## 9. Test Requirements

| Test Area | Coverage Required |
|---|---|
| Git operations | Worktree create, parse, idempotency, conflict detection, merge check, commit check, ignorable changes |
| IDE module | IDE detection (bundle ID + fallback), tasks.json create/merge/idempotency |
| Daemon server | Lifecycle (start, register, heartbeat, timeout, cleanup, idle shutdown), message protocol |
| Heartbeat client | Arg parsing, heartbeat sending, connection error handling |
| Socket utilities | Path computation, determinism, directory creation, liveness check, stale cleanup |
| Cleanup logic | All 4 branches of the decision tree (preserve with changes, delete no commits, delete merged, preserve unmerged) |
| Smoke test | Barrel export loads without errors |
