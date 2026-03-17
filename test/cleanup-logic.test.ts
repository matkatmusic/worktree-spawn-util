// E2E tests for the daemon's worktree cleanup decision logic.
// Each test creates a real git repo, spawns a real daemon and heartbeat process,
// kills the heartbeat to simulate IDE window close, and verifies whether the
// daemon correctly deletes or preserves the worktree.
// All output is written to test/e2e-test.log with ==SERVER== / ==CLIENT== prefixes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { simpleGit } from "simple-git";
import { getSocketPath, isSocketAlive } from "../src/socket.js";
import { Logger } from "../src/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to compiled CLI scripts
const DAEMON_JS = join(__dirname, "..", "dist", "cli", "daemon.js");
const HEARTBEAT_JS = join(__dirname, "..", "dist", "cli", "heartbeat.js");

// Short timeouts for fast tests
// Heartbeat interval (500ms) must be shorter than timeout (3s)
const HB_TIMEOUT = "3000";
const CHECK_INTERVAL = "500";
const HB_INTERVAL = "500";

// Logger instance — writes to test/e2e-test.log and console
const LOG_FILE = join(__dirname, "e2e-test.log");
const testLogger = new Logger(LOG_FILE);

function log(prefix: "SERVER" | "CLIENT", source: string, message: string): void {
  /* PURPOSE/INTENT: Write a single prefixed, tagged log line via the Logger. */
  testLogger.log(`==${prefix}== [${source}] ${message}`);
}

function loggedGit(cwd: string, prefix: "SERVER" | "CLIENT" = "SERVER") {
  /* PURPOSE/INTENT: Create a simpleGit wrapper that logs every git command invocation
     and its full output to the E2E log file, so the log captures the exact git state
     at every point in the test. */
  const git = simpleGit(cwd);
  const originalRaw = git.raw.bind(git);

  git.raw = (async (args: string[]) => {
    /* PURPOSE/INTENT: Intercept git.raw() calls to log the command and its output. */
    const cmd = `git ${args.join(" ")}`;
    log(prefix, "git", `$ ${cmd}`);
    const result = await originalRaw(args);
    if (result.trim()) {
      for (const line of result.trim().split("\n")) {
        log(prefix, "git", `  ${line}`);
      }
    } else {
      log(prefix, "git", `  (no output)`);
    }
    return result;
  }) as typeof git.raw;

  return git;
}

function waitForOutput(proc: ChildProcess, pattern: string, timeoutMs = 15000): Promise<void> {
  /* PURPOSE/INTENT: Block until a specific string appears in a child process's stdout,
     used to synchronize test flow with daemon/heartbeat process state (e.g., wait
     until 3 heartbeats are received before killing the heartbeat). */
  return new Promise((resolve, reject) => {
    log("SERVER", "waitForOutput", `Waiting for pattern: "${pattern}" (timeout: ${timeoutMs}ms)`);
    const timer = setTimeout(() => {
      /* PURPOSE/INTENT: Reject the promise if the pattern is not found within the timeout. */
      log("SERVER", "waitForOutput", `TIMEOUT waiting for "${pattern}" after ${timeoutMs}ms`);
      reject(new Error(`Timeout waiting for "${pattern}"`));
    }, timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      /* PURPOSE/INTENT: Check each chunk of stdout for the target pattern. */
      if (chunk.toString().includes(pattern)) {
        log("SERVER", "waitForOutput", `Pattern "${pattern}" matched`);
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      /* PURPOSE/INTENT: Fail fast if the process exits before the pattern appears. */
      clearTimeout(timer);
      log("SERVER", "waitForOutput", `Process exited with code ${code} before "${pattern}" appeared`);
      reject(new Error(`Process exited before "${pattern}" appeared`));
    });
  });
}

function sendMessage(socketPath: string, msg: object): Promise<void> {
  /* PURPOSE/INTENT: Send a single JSON message to the daemon over the Unix domain socket.
     Used to send "register" messages that tell the daemon the parent branch/commit
     for a worktree before heartbeats begin. */
  const msgStr = JSON.stringify(msg);
  log("CLIENT", "sendMessage", `Connecting to ${socketPath}`);
  log("CLIENT", "sendMessage", `Sending: ${msgStr}`);
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath }, () => {
      /* PURPOSE/INTENT: Write the message once connected, then close. */
      client.write(msgStr + "\n");
      client.end();
      log("CLIENT", "sendMessage", `Message sent and connection closed`);
      resolve();
    });
    client.on("error", (err) => {
      /* PURPOSE/INTENT: Log and propagate socket connection errors. */
      log("CLIENT", "sendMessage", `ERROR: ${err.message}`);
      reject(err);
    });
  });
}

async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
  /* PURPOSE/INTENT: Check if a git branch exists in the repo. Used in test assertions
     to verify whether the daemon deleted the worktree branch or preserved it. */
  const git = loggedGit(repoRoot);
  const result = await git.raw(["branch", "--list", branchName]);
  const exists = result.trim().length > 0;
  log("SERVER", "branchExists", `Branch "${branchName}": ${exists ? "EXISTS" : "NOT FOUND"} → returning ${exists}`);
  return exists;
}

async function dirExists(path: string): Promise<boolean> {
  /* PURPOSE/INTENT: Check if a directory exists on disk. Used in test assertions
     to verify whether the daemon removed the worktree directory or preserved it. */
  try {
    await access(path);
    log("SERVER", "dirExists", `Directory "${path}": EXISTS → returning true`);
    return true;
  } catch {
    /* PURPOSE/INTENT: ENOENT means directory was deleted — expected in delete scenarios. */
    log("SERVER", "dirExists", `Directory "${path}": NOT FOUND → returning false`);
    return false;
  }
}

async function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  /* PURPOSE/INTENT: Poll the daemon's Unix socket until it accepts connections.
     The daemon needs a moment to start and bind the socket after being spawned.
     Without this, the register message and heartbeats would fail with ENOENT. */
  log("SERVER", "waitForSocket", `Polling socket ${socketPath} (timeout: ${timeoutMs}ms)`);
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    /* PURPOSE/INTENT: Try connecting every 100ms until the socket responds. */
    attempts++;
    if (await isSocketAlive(socketPath)) {
      log("SERVER", "waitForSocket", `Socket alive after ${attempts} attempts (${Date.now() - start}ms) → ready`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  log("SERVER", "waitForSocket", `TIMEOUT after ${attempts} attempts (${timeoutMs}ms) → throwing`);
  throw new Error(`Daemon socket not ready after ${timeoutMs}ms`);
}

describe("cleanup logic — E2E", () => {
  let repoRoot: string;
  let testStartCommit: string;
  let socketPath: string;
  let daemonProc: ChildProcess | null;
  let heartbeatProc: ChildProcess | null;

  beforeEach(async () => {
    /* PURPOSE/INTENT: Set up a fresh git repo with a testRoot branch for each test.
       Each test gets an isolated repo so worktree state doesn't leak between tests. */
    daemonProc = null;
    heartbeatProc = null;

    // Append separator for this test run
    testLogger.log("=".repeat(60));

    // Create a real git repo in a temp directory
    repoRoot = await realpath(await mkdtemp(join(tmpdir(), "e2e-cleanup-")));
    log("SERVER", "beforeEach", `Created temp repo at ${repoRoot}`);

    const git = loggedGit(repoRoot);
    await git.init();

    await git.raw(["config", "user.email", "test@test.com"]);
    await git.raw(["config", "user.name", "Test"]);

    // Initial commit on default branch
    await writeFile(join(repoRoot, "README.md"), "initial\n");
    await git.add(".");
    await git.commit("initial commit");
    const defaultBranch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    log("SERVER", "beforeEach", `Initial commit on "${defaultBranch}"`);

    // Create and checkout testRoot branch
    await git.raw(["checkout", "-b", "testRoot"]);

    // Capture the commit hash
    testStartCommit = (await git.revparse(["HEAD"])).trim();
    log("SERVER", "beforeEach", `TestStartCommit: ${testStartCommit}`);

    // Compute the socket path
    socketPath = await getSocketPath(repoRoot);
    log("SERVER", "beforeEach", `Socket path: ${socketPath}`);
    log("SERVER", "beforeEach", `Setup complete — ready for test`);
  });

  afterEach(async () => {
    /* PURPOSE/INTENT: Tear down all processes and temp files after each test.
       Kills daemon and heartbeat if still running, force-removes worktrees,
       and deletes the temp repo directory. */
    log("SERVER", "afterEach", `Starting teardown`);

    // Kill heartbeat if still running
    if (heartbeatProc && !heartbeatProc.killed) {
      /* PURPOSE/INTENT: Ensure the heartbeat process is stopped so it doesn't
         keep sending to a socket that's about to be cleaned up. */
      log("CLIENT", "afterEach", `Killing heartbeat process (PID ${heartbeatProc.pid})`);
      heartbeatProc.kill("SIGTERM");
    } else {
      log("CLIENT", "afterEach", `Heartbeat already stopped`);
    }

    // Kill daemon if still running
    if (daemonProc && !daemonProc.killed) {
      /* PURPOSE/INTENT: Stop the daemon so it releases the socket file and
         doesn't interfere with the next test's daemon. */
      log("SERVER", "afterEach", `Killing daemon process (PID ${daemonProc.pid})`);
      daemonProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    } else {
      log("SERVER", "afterEach", `Daemon already stopped`);
    }

    // Force-remove any remaining worktrees
    const git = loggedGit(repoRoot);
    try {
      /* PURPOSE/INTENT: Git won't let us delete the repo dir if worktrees still
         reference it, so we force-remove all non-main worktrees first. */
      const list = await git.raw(["worktree", "list", "--porcelain"]);
      const paths = list
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length))
        .filter((p) => p !== repoRoot);
      log("SERVER", "afterEach", `Found ${paths.length} worktrees to clean up`);
      for (const p of paths) {
        log("SERVER", "afterEach", `Force-removing worktree: ${p}`);
        await git.raw(["worktree", "remove", "--force", p]).catch(() => {});
      }
    } catch {
      log("SERVER", "afterEach", `Error listing worktrees (best effort)`);
    }

    log("SERVER", "afterEach", `Removing temp dir: ${repoRoot}`);
    await rm(repoRoot, { recursive: true, force: true });
    log("SERVER", "afterEach", `Teardown complete`);
  }, 30000);

  async function runHeartbeatCycle(worktreeName: string): Promise<string> {
    /* PURPOSE/INTENT: Run a complete heartbeat lifecycle — spawn daemon, register worktree,
       start heartbeat, wait for 3 heartbeats to confirm connectivity, kill heartbeat to
       simulate IDE window close, then wait for the daemon to evaluate and execute cleanup.
       Returns all daemon stdout for assertion matching. */
    let daemonOutput = "";

    // --- Spawn daemon ---
    log("SERVER", "runHeartbeatCycle", `Spawning daemon with --heartbeat-timeout=${HB_TIMEOUT} --check-interval=${CHECK_INTERVAL}`);
    daemonProc = spawn("node", [
      DAEMON_JS, repoRoot,
      `--heartbeat-timeout=${HB_TIMEOUT}`,
      `--check-interval=${CHECK_INTERVAL}`,
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
    log("SERVER", "runHeartbeatCycle", `Daemon spawned (PID ${daemonProc.pid})`);

    // Capture daemon stdout/stderr with ==SERVER== prefix
    daemonProc.stdout?.on("data", (chunk: Buffer) => {
      /* PURPOSE/INTENT: Pipe every line of daemon stdout into the log with ==SERVER== prefix,
         and accumulate into daemonOutput for assertion matching after the cycle. */
      const text = chunk.toString();
      daemonOutput += text;
      for (const line of text.split("\n").filter(Boolean)) {
        testLogger.log(`==SERVER== ${line}`);
      }
    });
    daemonProc.stderr?.on("data", (chunk: Buffer) => {
      /* PURPOSE/INTENT: Capture daemon stderr (e.g., git errors) into the log. */
      const text = chunk.toString();
      daemonOutput += text;
      for (const line of text.split("\n").filter(Boolean)) {
        testLogger.log(`==SERVER== [stderr] ${line}`);
      }
    });
    daemonProc.on("exit", (code) => {
      /* PURPOSE/INTENT: Log when the daemon process exits, for debugging unexpected shutdowns. */
      log("SERVER", "runHeartbeatCycle", `Daemon exited with code ${code}`);
    });

    // --- Wait for daemon socket ---
    await waitForSocket(socketPath);

    // --- Register worktree ---
    log("CLIENT", "runHeartbeatCycle", `Registering worktree "${worktreeName}" (parent: testRoot@${testStartCommit.slice(0, 7)})`);
    await sendMessage(socketPath, {
      type: "register",
      worktree: worktreeName,
      parentBranch: "testRoot",
      parentCommit: testStartCommit,
    });
    log("CLIENT", "runHeartbeatCycle", `Register sent, waiting 200ms for daemon to process`);
    await new Promise((r) => setTimeout(r, 200));

    // --- Spawn heartbeat ---
    log("CLIENT", "runHeartbeatCycle", `Spawning heartbeat with --interval=${HB_INTERVAL}`);
    heartbeatProc = spawn("node", [
      HEARTBEAT_JS,
      `--interval=${HB_INTERVAL}`,
      "--repo-root", repoRoot,
      "--worktree", worktreeName,
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
    log("CLIENT", "runHeartbeatCycle", `Heartbeat spawned (PID ${heartbeatProc.pid})`);

    // Capture heartbeat stdout/stderr with ==CLIENT== prefix
    heartbeatProc.stdout?.on("data", (chunk: Buffer) => {
      /* PURPOSE/INTENT: Pipe heartbeat stdout into the log with ==CLIENT== prefix. */
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        testLogger.log(`==CLIENT== ${line}`);
      }
    });
    heartbeatProc.stderr?.on("data", (chunk: Buffer) => {
      /* PURPOSE/INTENT: Capture heartbeat stderr (e.g., connection warnings) into the log. */
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        testLogger.log(`==CLIENT== [stderr] ${line}`);
      }
    });
    heartbeatProc.on("exit", (code) => {
      /* PURPOSE/INTENT: Log heartbeat exit for debugging (expected after SIGTERM). */
      log("CLIENT", "runHeartbeatCycle", `Heartbeat exited with code ${code}`);
    });

    // --- Wait for 3 heartbeats ---
    log("SERVER", "runHeartbeatCycle", `Waiting for daemon to receive 3 heartbeats`);
    await waitForOutput(daemonProc, "Received heartbeat #3");
    log("SERVER", "runHeartbeatCycle", `3 heartbeats confirmed — connectivity verified`);

    // --- Kill heartbeat (simulate IDE close) ---
    log("CLIENT", "runHeartbeatCycle", `Killing heartbeat (PID ${heartbeatProc.pid}) — simulating IDE window close`);
    heartbeatProc.kill("SIGTERM");
    heartbeatProc = null;

    // --- Wait for cleanup ---
    log("SERVER", "runHeartbeatCycle", `Waiting for daemon cleanup (timeout=${HB_TIMEOUT}ms + check=${CHECK_INTERVAL}ms)`);
    try {
      await waitForOutput(daemonProc, "cleanup", 10000);
      log("SERVER", "runHeartbeatCycle", `Cleanup detected in daemon output`);
    } catch (err) {
      log("SERVER", "runHeartbeatCycle", `Cleanup wait failed: ${err instanceof Error ? err.message : err}`);
    }
    log("SERVER", "runHeartbeatCycle", `Waiting 1s for git operations to complete`);
    await new Promise((r) => setTimeout(r, 1000));
    log("SERVER", "runHeartbeatCycle", `Heartbeat cycle complete — ready for verification`);

    return daemonOutput;
  }

  it("test 1: deletes worktree when no changes were made", async () => {
    /* PURPOSE/INTENT: Verify that when a worktree has no modifications and no commits,
       the daemon deletes both the worktree directory and the branch after heartbeat stops. */
    log("SERVER", "test1", `=== TEST 1: No changes to worktree ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test1", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);
    log("SERVER", "test1", `Worktree created — no modifications will be made`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test1", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test1", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test1", `Expected: worktree=false, branch=false`);
    log("SERVER", "test1", `Daemon output contains "Removed worktree and branch": ${output.includes("Removed worktree and branch: test")}`);

    expect(wtExists).toBe(false);
    expect(brExists).toBe(false);
    expect(output).toContain("Removed worktree and branch: test");
    log("SERVER", "test1", `=== TEST 1 PASSED ===`);
  }, 30000);

  it("test 2: preserves worktree when uncommitted file exists", async () => {
    /* PURPOSE/INTENT: Verify that when a worktree has an uncommitted file (outside
       .claude/.vscode), the daemon preserves the worktree and notifies the user. */
    log("SERVER", "test2", `=== TEST 2: Uncommitted file in worktree ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test2", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    log("CLIENT", "test2", `Writing uncommitted file: ${join(wtPath, "test.txt")}`);
    await writeFile(join(wtPath, "test.txt"), "test\n");
    log("CLIENT", "test2", `File written — deliberately NOT staging or committing`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test2", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test2", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test2", `Expected: worktree=true, branch=true`);
    log("SERVER", "test2", `Daemon output contains "uncommitted changes": ${output.includes("uncommitted changes")}`);
    log("SERVER", "test2", `Daemon output contains "preserving": ${output.includes("preserving")}`);

    expect(wtExists).toBe(true);
    expect(brExists).toBe(true);
    expect(output).toContain("uncommitted changes");
    expect(output).toContain("preserving");
    log("SERVER", "test2", `=== TEST 2 PASSED ===`);
  }, 30000);

  it("test 3: preserves worktree when branch has unmerged commits", async () => {
    /* PURPOSE/INTENT: Verify that when a worktree branch has commits that were NOT
       merged back into the parent branch, the daemon preserves the worktree to
       prevent losing the user's work. */
    log("SERVER", "test3", `=== TEST 3: Committed but not merged ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test3", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    const wtGit = loggedGit(wtPath, "CLIENT");
    log("CLIENT", "test3", `Writing file: ${join(wtPath, "test.txt")}`);
    await writeFile(join(wtPath, "test.txt"), "test\n");
    log("CLIENT", "test3", `Staging file`);
    await wtGit.add(".");
    log("CLIENT", "test3", `Committing as "added test file"`);
    await wtGit.commit("added test file");
    const commitHash = (await wtGit.revparse(["HEAD"])).trim();
    log("CLIENT", "test3", `Committed: ${commitHash}`);
    log("CLIENT", "test3", `Deliberately NOT merging into testRoot`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test3", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test3", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test3", `Expected: worktree=true, branch=true`);
    log("SERVER", "test3", `Daemon output contains "unmerged commits": ${output.includes("unmerged commits")}`);
    log("SERVER", "test3", `Daemon output contains "preserving": ${output.includes("preserving")}`);

    expect(wtExists).toBe(true);
    expect(brExists).toBe(true);
    expect(output).toContain("unmerged commits");
    expect(output).toContain("preserving");
    log("SERVER", "test3", `=== TEST 3 PASSED ===`);
  }, 30000);

  it("test 4: deletes worktree when branch is merged", async () => {
    /* PURPOSE/INTENT: Verify that when a worktree branch has commits AND those commits
       were merged back into the parent branch, the daemon safely deletes the worktree
       and branch since the work is preserved in the parent. */
    log("SERVER", "test4", `=== TEST 4: Committed and merged ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test4", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    const wtGit = loggedGit(wtPath, "CLIENT");
    log("CLIENT", "test4", `Writing file: ${join(wtPath, "test.txt")}`);
    await writeFile(join(wtPath, "test.txt"), "test\n");
    log("CLIENT", "test4", `Staging file`);
    await wtGit.add(".");
    log("CLIENT", "test4", `Committing as "added test file"`);
    await wtGit.commit("added test file");
    const commitHash = (await wtGit.revparse(["HEAD"])).trim();
    log("CLIENT", "test4", `Committed: ${commitHash}`);

    log("SERVER", "test4", `Merging "test" into "testRoot" (--no-ff to create merge commit)`);
    await git.raw(["merge", "test", "--no-ff", "-m", "merge test"]);
    const mergeCommit = (await git.revparse(["HEAD"])).trim();
    log("SERVER", "test4", `Merge complete — merge commit: ${mergeCommit}`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test4", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test4", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test4", `Expected: worktree=false, branch=false`);
    log("SERVER", "test4", `Daemon output contains "merged": ${output.includes("merged")}`);
    log("SERVER", "test4", `Daemon output contains "Removed worktree and branch": ${output.includes("Removed worktree and branch: test")}`);

    expect(wtExists).toBe(false);
    expect(brExists).toBe(false);
    expect(output).toContain("merged");
    expect(output).toContain("Removed worktree and branch: test");
    log("SERVER", "test4", `=== TEST 4 PASSED ===`);
  }, 30000);

  it("test 5: deletes worktree when only .vscode changes exist", async () => {
    /* PURPOSE/INTENT: Verify that when the only changes in a worktree are in .vscode/
       (tool-generated files like tasks.json), the daemon treats them as ignorable and
       deletes the worktree. This is the unanimous #1 finding from the 4-way debate. */
    log("SERVER", "test5", `=== TEST 5: Only ignorable (.vscode) changes ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test5", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    log("CLIENT", "test5", `Creating .vscode/ directory in worktree`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(wtPath, ".vscode"), { recursive: true });
    log("CLIENT", "test5", `Writing .vscode/tasks.json (ignorable file)`);
    await writeFile(join(wtPath, ".vscode", "tasks.json"), '{"version": "2.0.0"}');
    log("CLIENT", "test5", `Only .vscode/ changes present — should be treated as ignorable`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test5", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test5", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test5", `Expected: worktree=false, branch=false`);

    expect(wtExists).toBe(false);
    expect(brExists).toBe(false);
    expect(output).toContain("Removed worktree and branch: test");
    log("SERVER", "test5", `=== TEST 5 PASSED ===`);
  }, 30000);

  it("test 6: preserves worktree when mixed ignorable and non-ignorable changes", async () => {
    /* PURPOSE/INTENT: Verify that when a worktree has both ignorable (.vscode/) and
       non-ignorable (real user files) changes, the non-ignorable changes cause the
       daemon to preserve the worktree. The ignorable files should NOT mask real work. */
    log("SERVER", "test6", `=== TEST 6: Mixed ignorable + non-ignorable changes ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test6", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    log("CLIENT", "test6", `Adding ignorable file: .vscode/tasks.json`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(wtPath, ".vscode"), { recursive: true });
    await writeFile(join(wtPath, ".vscode", "tasks.json"), '{}');

    log("CLIENT", "test6", `Adding non-ignorable file: test.txt`);
    await writeFile(join(wtPath, "test.txt"), "real user work\n");
    log("CLIENT", "test6", `Both files present — non-ignorable should trigger preservation`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test6", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test6", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test6", `Expected: worktree=true, branch=true`);

    expect(wtExists).toBe(true);
    expect(brExists).toBe(true);
    expect(output).toContain("uncommitted changes");
    expect(output).toContain("preserving");
    log("SERVER", "test6", `=== TEST 6 PASSED ===`);
  }, 30000);

  it("test 7: preserves worktree when file is staged but not committed", async () => {
    /* PURPOSE/INTENT: Verify that a file which has been `git add`-ed (staged) but not
       committed is treated as an uncommitted change and causes the daemon to preserve
       the worktree. Staged files show as "A " in git status --porcelain. */
    log("SERVER", "test7", `=== TEST 7: Staged but not committed ===`);
    const git = loggedGit(repoRoot);
    const wtPath = join(repoRoot, ".worktrees", "test");

    log("SERVER", "test7", `Creating worktree "test" at ${wtPath}`);
    await git.raw(["worktree", "add", "-b", "test", wtPath]);

    const wtGit = loggedGit(wtPath, "CLIENT");
    log("CLIENT", "test7", `Writing file: test.txt`);
    await writeFile(join(wtPath, "test.txt"), "staged but not committed\n");
    log("CLIENT", "test7", `Staging file with git add (NOT committing)`);
    await wtGit.add(".");
    log("CLIENT", "test7", `File is staged — git status shows "A  test.txt"`);

    const output = await runHeartbeatCycle("test");

    log("SERVER", "test7", `--- Verification ---`);
    const wtExists = await dirExists(wtPath);
    const brExists = await branchExists(repoRoot, "test");
    log("SERVER", "test7", `Result:   worktree=${wtExists}, branch=${brExists}`);
    log("SERVER", "test7", `Expected: worktree=true, branch=true`);

    expect(wtExists).toBe(true);
    expect(brExists).toBe(true);
    expect(output).toContain("uncommitted changes");
    expect(output).toContain("preserving");
    log("SERVER", "test7", `=== TEST 7 PASSED ===`);
  }, 30000);
});
