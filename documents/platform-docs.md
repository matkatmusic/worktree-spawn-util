# worktree-spawn-util — Platform Documentation

## Project Overview

`worktree-spawn-util` is a TypeScript utility library and CLI toolkit for automating the lifecycle of git worktrees within a multi-agent review orchestration workflow. Its intended purpose is to:

1. Check whether a named worktree already exists in a repository.
2. Create a git worktree (and its branch) on demand.
3. Open a configured IDE or agent window (e.g., AGY, Cursor, VS Code) inside that worktree.
4. Monitor the IDE/agent process and, when it exits, automatically clean up — deleting the worktree folder and killing the associated tmux session.
5. Optionally spawn Claude Code or a tmux session within the worktree environment.

The project is in an early scaffold phase. All modules export their type contracts, and the CLI entry points are implemented as runnable stubs. The full orchestration logic (worktree creation, IDE launch, process polling, and teardown) is documented in TODO comments and will be layered in incrementally.

---

## Configuration

### `package.json`

| Field | Value |
|---|---|
| Name | `worktree-spawn-util` |
| Version | `0.1.0` |
| Module format | ESM (`"type": "module"`) |
| Entry point | `dist/index.js` |
| Type declarations | `dist/index.d.ts` |

Scripts:

| Script | Command |
|---|---|
| `build` | `tsc` |
| `dev` | `tsc --watch` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |

Runtime dependencies:

- `simple-git` ^3.27.0 — high-level wrapper around the git CLI, used to drive worktree CRUD operations.

Dev dependencies:

- `typescript` ^5.8.2
- `vitest` ^3.0.9
- `@types/node` ^22.13.10

### `tsconfig.json`

Compiles `src/` to `dist/` with standard TypeScript 5 settings. The `"type": "module"` package setting means all imports use `.js` extensions in source (matching Node ESM resolution).

### `vitest.config.ts`

Minimal Vitest configuration. The `test.root` is set to the project root, so Vitest discovers test files anywhere in the tree. No custom reporters, timeouts, or environment overrides are configured.

---

## Module Breakdown

### `src/index.ts` — Barrel Export

**Purpose:** Single public entry point that re-exports every public symbol from the four submodules. Consumers of the library import exclusively from this file.

**Exports:**

```ts
export * from "./git/index.js";
export * from "./ide/index.js";
export * from "./process/index.js";
export * from "./config/index.js";
```

**Connections:** Aggregates all four domain modules. Nothing is defined here directly; it is purely a re-export hub. This pattern keeps each domain isolated while presenting a flat import surface to callers.

---

### `src/config/index.ts` — Configuration Module

**Purpose:** Defines the shape of runtime configuration consumed by both the CLI entry points and the library internals.

**Exported types:**

```ts
export type SpawnConfig = {
  ideCommand: string;     // shell command used to launch the IDE/agent window
  pollIntervalMs: number; // how frequently the process monitor checks whether the IDE is still running
};
```

**Connections:** `SpawnConfig` is the central configuration contract. The `ide` module reads `ideCommand` to know what binary to invoke; the `process` module reads `pollIntervalMs` to schedule its liveness checks. CLI entry points will construct or load a `SpawnConfig` at startup and pass it downstream.

---

### `src/git/index.ts` — Git Module

**Purpose:** Encapsulates all git worktree operations — creation, deletion, listing, and branch management. Internally intended to use the `simple-git` runtime dependency.

**Exported types:**

```ts
export type WorktreeInfo = {
  path: string;   // absolute filesystem path of the worktree
  branch: string; // git branch checked out in this worktree
};
```

**Planned operations (per TODO commentary):**

- Check for existing worktree by name before attempting creation.
- Create a worktree at a user-specified name/path with a corresponding branch.
- Delete a worktree folder when the IDE/agent session ends.
- Detect merge events to trigger automatic teardown.

**Connections:** Consumed by `src/cli/spawn.ts`, which provides the worktree name from its `--name` argument. `WorktreeInfo` is the return value that subsequent modules (ide, process) use to locate the working directory.

---

### `src/ide/index.ts` — IDE Launcher Module

**Purpose:** Provides a configurable mechanism to open an IDE or agent application window inside a given worktree directory. The command string is not hardcoded; it is read from `IdeConfig` so the caller can substitute any editor (VS Code via `code`, AGY, Cursor, Windsurf, etc.).

**Exported types:**

```ts
export type IdeConfig = {
  command: string; // e.g. "agy", "cursor", "code"
};
```

**Planned behavior:**

- Accept a `WorktreeInfo` and an `IdeConfig`.
- Spawn the IDE process with the worktree path as the working directory argument.
- Return a `ProcessHandle` so the process module can track it.

**Connections:** Receives `WorktreeInfo` from the git module; receives `IdeConfig` derived from `SpawnConfig.ideCommand`. Returns (or passes through) a `ProcessHandle` to the process module.

---

### `src/process/index.ts` — Process Monitor Module

**Purpose:** Tracks a running IDE or agent process by PID and detects when it exits, so teardown logic (worktree deletion, tmux kill) can be triggered.

**Exported types:**

```ts
export type ProcessHandle = {
  pid: number; // OS process ID of the launched IDE/agent
};
```

**Planned behavior:**

- Poll the process at the interval specified by `SpawnConfig.pollIntervalMs`.
- On process exit, emit an event or invoke a callback that triggers git module teardown and tmux session kill.

**Connections:** Receives a `ProcessHandle` from the ide module. Reads poll interval from `SpawnConfig`. On close detection, delegates cleanup back to the git module and the tmux/Claude spawning logic in the CLI layer.

---

### `src/cli/spawn.ts` — Spawn CLI Entry Point

**Purpose:** The primary command-line interface for creating and entering a worktree session. Intended to be invoked by an external task runner (e.g., `tasks.json` in the parent orchestrator).

**Current implementation (stub):**

```ts
#!/usr/bin/env node
const args = process.argv.slice(2);
const force = args.includes("--force");
const name = args.filter((a) => a !== "--force")[0];
console.log("[spawn stub]", { force, worktreeName: name ?? "(none)" });
process.exit(0);
```

**Argument contract:**

| Argument | Type | Description |
|---|---|---|
| `<name>` | positional string | Name of the worktree to create or enter |
| `--force` | flag | Overwrite an existing worktree with the same name |

**Planned full behavior:**

1. Parse `name` and `--force` from `argv`.
2. Call git module to check for / create the worktree.
3. Call ide module to open the configured editor in the worktree.
4. Hand off the `ProcessHandle` to the process module to begin monitoring.
5. Spawn Claude Code and/or a tmux session inside the worktree.

**Connections:** Orchestrates git, ide, and process modules in sequence. Entry point for the end-to-end worktree lifecycle.

---

### `src/cli/daemon.ts` — Daemon CLI Entry Point

**Purpose:** A background process entry point that watches a repository root for lifecycle events, coordinating multiple concurrent worktree sessions or handling cleanup of orphaned worktrees.

**Current implementation (stub):**

```ts
#!/usr/bin/env node
const repoRoot = process.argv[2];
console.log("[daemon stub]", { repoRoot: repoRoot ?? "(none)" });
process.exit(0);
```

**Argument contract:**

| Argument | Type | Description |
|---|---|---|
| `<repoRoot>` | positional path | Absolute path to the git repository root to watch |

**Planned behavior:**

- Run as a long-lived background process (likely under tmux or as a system service).
- Listen for worktree creation and teardown signals.
- Enforce cleanup of stale worktrees when IDE processes die unexpectedly.

**Connections:** Operates at a higher scope than `spawn.ts` — it supervises multiple `spawn` sessions rather than owning a single one. Reads from git module to enumerate live worktrees.

---

### `test/smoke.test.ts` — Smoke Test

**Purpose:** A single-assertion integration sanity check confirming the library loads without throwing errors. Acts as a compile-and-import gate.

**Test coverage:**

```ts
describe("worktree-spawn-util", () => {
  it("loads the module without errors", () => {
    expect(lib).toBeDefined();
  });
});
```

**What it validates:** That all four submodules (`git`, `ide`, `process`, `config`) export something truthy and that the barrel `src/index.ts` resolves without runtime errors. It does not test behavior.

**Planned test expansion (from TODO comments):**

- Worktree existence check before creation.
- End-to-end: create worktree, open IDE, detect close, delete worktree and kill tmux.
- Spawn Claude Code inside a worktree.
- Spawn and manage a tmux session.

---

## Architecture Summary

How the pieces fit together for a single session:

```
tasks.json (parent orchestrator)
        |
        v
src/cli/spawn.ts        <-- primary CLI entry (name, --force)
        |
        +---> src/git/index.ts       create/delete worktree via simple-git
        |            |
        |            v  WorktreeInfo { path, branch }
        |
        +---> src/ide/index.ts       launch IDE with worktree path
        |            |
        |            v  ProcessHandle { pid }
        |
        +---> src/process/index.ts   poll pid, detect window close
        |            |
        |            v  on-exit callback
        |
        +---> src/git/index.ts       delete worktree, kill tmux session

src/cli/daemon.ts       <-- optional supervisor (watches repoRoot, multi-session)

src/config/index.ts     <-- SpawnConfig { ideCommand, pollIntervalMs }
                            read orthogonally by ide and process modules

src/index.ts            <-- barrel export surface
                            WorktreeInfo | IdeConfig | ProcessHandle | SpawnConfig
```

The data flow for a single session is strictly linear: the git module produces a `WorktreeInfo`, the ide module consumes it and produces a `ProcessHandle`, and the process module consumes the handle to watch for exit. Configuration flows in from `SpawnConfig` orthogonally to all modules. The daemon provides an optional supervisory layer over multiple concurrent sessions.

All modules are currently at the type-definition and stub stage. The `simple-git` dependency is the only runtime library, signaling that full git worktree operations are the next implementation milestone.

---

## Known Issues

### Antigravity (AGY) fires `folderOpen` tasks twice

**Status:** Known, not affecting functionality.

**Symptom:** When Antigravity opens a worktree folder, tasks with `runOn: "folderOpen"` are executed twice, approximately 5 seconds apart. The daemon log shows duplicate heartbeat `#1` and `#2` entries before normalizing to a single stream.

**Impact:** None. The first heartbeat process is killed when the second starts. The daemon tracks heartbeats by worktree name (not process identity), so the replacement is seamless. Cleanup triggers correctly when the IDE window is closed.

**Investigated causes (all ruled out):**
- `reloadIdeWindow()` — removed, double-fire persists
- VS Code task sequencing (`dependsOrder`) — reverted, double-fire persists
- Node.js debug auto-attach (`ms-vscode.js-debug` "always" mode) — disabled, double-fire persists
- Multiple `folderOpen` tasks interacting — reduced to single task, double-fire persists

**Conclusion:** This appears to be an Antigravity-specific behavior during window initialization. Not reproducible in standard VS Code.
