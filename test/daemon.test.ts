import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { createDaemonServer, type DaemonHandle } from "../src/daemon/server.js";

describe("createDaemonServer", () => {
  let tmpDir: string;
  let socketPath: string;
  let handle: DaemonHandle | null;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "daemon-test-")));
    socketPath = join(tmpDir, "daemon.sock");
    handle = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (handle) {
      handle.shutdown();
      // Brief wait for server to close
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts and listens on the socket path", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    // Verify we can connect
    const connected = await new Promise<boolean>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.end();
        resolve(true);
      });
      client.on("error", () => resolve(false));
    });

    expect(connected).toBe(true);
  });

  it("receives heartbeat messages and tracks them", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    // Send a heartbeat
    await new Promise<void>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.write(JSON.stringify({ type: "heartbeat", worktree: "my-feature" }) + "\n", () => {
          client.end();
          // Brief delay for server to process
          setTimeout(resolve, 50);
        });
      });
    });

    expect(handle.heartbeats.has("my-feature")).toBe(true);
  });

  it("tracks multiple worktrees independently", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    // Send heartbeats for two worktrees
    for (const name of ["feat-a", "feat-b"]) {
      await new Promise<void>((resolve) => {
        const client = createConnection({ path: socketPath }, () => {
          client.write(JSON.stringify({ type: "heartbeat", worktree: name }) + "\n", () => {
            client.end();
            setTimeout(resolve, 50);
          });
        });
      });
    }

    expect(handle.heartbeats.has("feat-a")).toBe(true);
    expect(handle.heartbeats.has("feat-b")).toBe(true);
  });

  it("emits cleanup event when heartbeat times out", async () => {
    handle = createDaemonServer(socketPath, tmpDir, {
      heartbeatTimeoutMs: 200,
      checkIntervalMs: 100,
      idleShutdownMs: 999_999, // Don't idle-shutdown during test
    });

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    // Send one heartbeat
    await new Promise<void>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.write(JSON.stringify({ type: "heartbeat", worktree: "expiring" }) + "\n", () => {
          client.end();
          setTimeout(resolve, 50);
        });
      });
    });

    expect(handle.heartbeats.has("expiring")).toBe(true);

    // Wait for timeout
    const cleanedUp = new Promise<string>((resolve) => {
      handle!.events.on("cleanup", (name: string) => resolve(name));
    });

    vi.advanceTimersByTime(300);

    const cleaned = await cleanedUp;
    expect(cleaned).toBe("expiring");
    expect(handle.heartbeats.has("expiring")).toBe(false);
  });

  it("emits idle-shutdown when no worktrees tracked for idleShutdownMs", async () => {
    handle = createDaemonServer(socketPath, tmpDir, {
      heartbeatTimeoutMs: 200,
      checkIntervalMs: 100,
      idleShutdownMs: 500,
    });

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    const shutdownPromise = new Promise<void>((resolve) => {
      handle!.events.on("idle-shutdown", resolve);
    });

    vi.advanceTimersByTime(600);

    await shutdownPromise;
    // If we got here, idle-shutdown was emitted
    handle = null; // Already shut down
  });

  it("ignores malformed messages", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    // Send garbage
    await new Promise<void>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.write("not valid json\n", () => {
          client.end();
          setTimeout(resolve, 50);
        });
      });
    });

    expect(handle.heartbeats.size).toBe(0);
  });

  it("ignores messages without type=heartbeat", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    await new Promise<void>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.write(JSON.stringify({ type: "unknown", worktree: "test" }) + "\n", () => {
          client.end();
          setTimeout(resolve, 50);
        });
      });
    });

    expect(handle.heartbeats.size).toBe(0);
  });

  it("cleans up socket file on shutdown", async () => {
    handle = createDaemonServer(socketPath, tmpDir);

    await new Promise<void>((resolve) => {
      handle!.events.on("listening", resolve);
    });

    handle.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle = null;

    // Socket should be gone
    const alive = await new Promise<boolean>((resolve) => {
      const client = createConnection({ path: socketPath }, () => {
        client.end();
        resolve(true);
      });
      client.on("error", () => resolve(false));
    });

    expect(alive).toBe(false);
  });
});
