# Daemon Port Discovery — Multi-AI Research Synthesis

## Agents Consulted

| Agent | Model | Status | Top Pick |
|---|---|---|---|
| Gemini (debate) | gemini-3.1-pro-preview | Completed | Port file outside repo |
| Codex (debate) | gpt-5.4 | Completed | CLI subcommand + Unix domain socket |
| Codex (research) | gpt-5.4 | Completed | Unix domain socket |
| Claude (7 research agents) | claude-opus-4-6 | Completed | Unix domain socket |
| Claude (backend-architect) | claude-opus-4-6 | Completed (write-blocked) | Unix domain socket |
| Gemini (research) | gemini-3.1-pro-preview | Failed (429 rate limit) | N/A |

---

## Consensus Ranking

### #1: Unix Domain Socket as Primary Transport (4/5 agents agree)

**The winning insight:** Don't discover the port — eliminate the problem entirely.

Instead of the daemon listening on a dynamic TCP port and needing discovery, the daemon listens on a **Unix domain socket at a deterministic path**. The path is computed from `realpath(repoRoot)`, so any process can find it independently.

**Socket path scheme:**
```
/tmp/wtsu-<uid>/<sha256(realpath(repoRoot)).slice(0,12)>.sock
```

**tasks.json heartbeat command:**
```bash
# Option A: curl with --unix-socket
curl --unix-socket /tmp/wtsu-501/a1b2c3d4e5f6.sock -X POST http://localhost/heartbeat/<worktree-name>

# Option B: CLI subcommand (Codex's preferred variant)
worktree-spawn-util heartbeat --repo-root /abs/path --worktree my-feature
```

**Why it wins:**
- **No discovery needed** — the socket path IS the address, computed deterministically
- **No stale port files** — socket cleanup is simpler than file cleanup
- **No network exposure** — nothing listens on TCP at all
- **Multi-daemon** — one socket per repo hash, no collisions
- **Industry precedent** — Docker, tmux, PostgreSQL, ssh-agent all use this pattern
- **Native Node.js support** — `net.createServer().listen({ path })`, zero dependencies
- **80-150 LoC** implementation

**Pitfalls to handle:**
1. `realpath()` the repo root before hashing (symlink normalization)
2. Keep socket paths short — macOS limit is 104 chars (use `/tmp/` not `$TMPDIR`)
3. On startup, probe existing socket before unlinking (check for live daemon)
4. Set `0700` permissions on the parent directory
5. Clean up sockets on process exit via `process.on('exit'/'SIGINT'/'SIGTERM')`
6. Handle concurrent `pick-repo.ts` invocations for the same repo (only one daemon wins)

---

### #2: Port/PID File Outside the Repo (Gemini's #1, everyone else's #2)

**When to use:** If you need plain TCP HTTP for debugging/inspection with browser/Postman.

Write `{ pid, port, repoRealpath, startedAt }` to `~/.config/worktree-daemon/<repoHash>.json`. Validate with triple check: PID liveness → port probe → health endpoint identity match.

**Why it's #2:**
- Simpler mental model (plain HTTP)
- Better DX for ad-hoc debugging
- But introduces stale file handling, atomic writes, PID reuse edge cases

---

### #3-6: Not Recommended as Primary

| Rank | Approach | Why Not |
|---|---|---|
| #3 | Fixed port + sequential probing | O(N) scan, race conditions, identity verification needed |
| #4 | Hash-based deterministic port | Collision handling recreates discovery; deceptively simple |
| #5 | OS process table (lsof/ss) | Brittle shell parsing, cross-platform inconsistency |
| #6 | Process argument inspection (ps) | Debugging-only; worst reliability |

---

## Recommended Hybrid

**Primary:** Unix domain socket for all heartbeat/control traffic
**Optional:** TCP endpoint for debugging only, with port discoverable via the socket

This gives you the reliability of UDS with the developer convenience of HTTP inspection when needed.

---

## Key Disagreement: Gemini vs Everyone Else

**Gemini** ranked port files #1 because:
- macOS `$TMPDIR` paths are long, risking the 104-char socket path limit
- Plain HTTP is more debuggable

**Rebuttal** (from Codex/Claude):
- Use `/tmp/wtsu-<uid>/` instead of `$TMPDIR` — stays well under 104 chars
- `curl --unix-socket` works for debugging; add optional TCP if needed

---

## Implementation Notes for This Codebase

- **Daemon entry point** (`src/cli/daemon.ts`): Currently a 5-line stub — no migration cost
- **Task generation** (`src/ide/index.ts`): `writeWorktreeTasksFile()` is the single injection point for the heartbeat command
- **No existing port/socket logic** — clean greenfield implementation

## Sources

- Docker daemon sockets: docs.docker.com/reference/cli/dockerd/
- tmux socket model: github.com/tmux/tmux/wiki/Advanced-Use
- PostgreSQL Unix sockets: postgresql.org/docs/current/runtime-config-connection.html
- Chrome DevToolsActivePort: chromium.googlesource.com
- curl --unix-socket: curl.se/docs/manpage.html
- Node.js IPC: nodejs.org/api/net.html
- ssh-agent: man.openbsd.org/ssh-agent.1
