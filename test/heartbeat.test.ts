import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { parseArgs, sendHeartbeat } from "../src/heartbeat/client.js";

describe("parseArgs", () => {
  it("parses --repo-root and --worktree", () => {
    const result = parseArgs(["--repo-root", "/my/repo", "--worktree", "feat-x"]);
    expect(result).toEqual({ repoRoot: "/my/repo", worktree: "feat-x" });
  });

  it("handles args in any order", () => {
    const result = parseArgs(["--worktree", "feat-x", "--repo-root", "/my/repo"]);
    expect(result).toEqual({ repoRoot: "/my/repo", worktree: "feat-x" });
  });

  it("returns empty strings when args are missing", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ repoRoot: "", worktree: "" });
  });

  it("returns empty string for missing values", () => {
    const result = parseArgs(["--repo-root"]);
    expect(result).toEqual({ repoRoot: "", worktree: "" });
  });
});

describe("sendHeartbeat", () => {
  let tmpDir: string;
  let testSocketPath: string;
  let server: Server;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "hb-test-")));
    testSocketPath = join(tmpDir, "hb.sock");
  });

  afterEach(async () => {
    if (server) {
      server.close();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends correctly formatted JSON message with newline delimiter", async () => {
    const received = new Promise<string>((resolve) => {
      server = createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
        });
        socket.on("end", () => {
          resolve(data);
        });
      });
      server.listen(testSocketPath);
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => {
      server.on("listening", resolve);
    });

    sendHeartbeat(testSocketPath, "my-feature");

    const msg = await received;
    expect(msg).toBe('{"type":"heartbeat","worktree":"my-feature"}\n');
  });

  it("sends message with correct worktree name", async () => {
    const received = new Promise<string>((resolve) => {
      server = createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
        });
        socket.on("end", () => {
          resolve(data);
        });
      });
      server.listen(testSocketPath);
    });

    await new Promise<void>((resolve) => {
      server.on("listening", resolve);
    });

    sendHeartbeat(testSocketPath, "bugfix-123");

    const msg = await received;
    const parsed = JSON.parse(msg.trim());
    expect(parsed.type).toBe("heartbeat");
    expect(parsed.worktree).toBe("bugfix-123");
  });

  it("does not crash when daemon is not reachable", async () => {
    // Point at a non-existent socket — should warn but not throw
    sendHeartbeat(join(tmpDir, "nonexistent.sock"), "test");

    // If we get here without throwing, the test passes
    // Brief wait for the error handler to fire
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
