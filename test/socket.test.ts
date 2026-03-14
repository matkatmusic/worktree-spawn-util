import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, stat, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import {
  getSocketDir,
  ensureSocketDir,
  getSocketPath,
  isSocketAlive,
  cleanStaleSocket,
} from "../src/socket/index.js";

describe("getSocketDir", () => {
  it("returns a path under /tmp/ with wtsu prefix and uid", () => {
    const dir = getSocketDir();
    const uid = process.getuid?.() ?? 0;
    expect(dir).toBe(`/tmp/wtsu-${uid}`);
  });
});

describe("ensureSocketDir", () => {
  it("creates the directory if it does not exist", () => {
    // ensureSocketDir is idempotent — calling it should not throw
    const dir = ensureSocketDir();
    expect(dir).toBe(getSocketDir());
  });

  it("returns existing directory without error", () => {
    // Call twice — second call should not throw
    ensureSocketDir();
    const dir = ensureSocketDir();
    expect(dir).toBe(getSocketDir());
  });

  it("creates directory with 0o700 permissions", async () => {
    const dir = ensureSocketDir();
    const stats = await stat(dir);
    // Check owner permissions (rwx = 7), masking off file type bits
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("getSocketPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "socket-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a path ending in .sock", async () => {
    const sockPath = await getSocketPath(tmpDir);
    expect(sockPath).toMatch(/\.sock$/);
  });

  it("is deterministic — same input produces same output", async () => {
    const path1 = await getSocketPath(tmpDir);
    const path2 = await getSocketPath(tmpDir);
    expect(path1).toBe(path2);
  });

  it("produces different paths for different repo roots", async () => {
    const tmpDir2 = await realpath(await mkdtemp(join(tmpdir(), "socket-test2-")));
    try {
      const path1 = await getSocketPath(tmpDir);
      const path2 = await getSocketPath(tmpDir2);
      expect(path1).not.toBe(path2);
    } finally {
      await rm(tmpDir2, { recursive: true, force: true });
    }
  });

  it("resolves symlinks — symlink and real path produce same socket path", async () => {
    const symlinkPath = join(tmpDir, "link-to-self");
    await symlink(tmpDir, symlinkPath);

    // getSocketPath resolves via realpath, so both should match
    const pathFromReal = await getSocketPath(tmpDir);
    const pathFromLink = await getSocketPath(symlinkPath);
    expect(pathFromReal).toBe(pathFromLink);
  });

  it("total path length is under 104 chars (macOS socket limit)", async () => {
    const sockPath = await getSocketPath(tmpDir);
    expect(sockPath.length).toBeLessThan(104);
  });
});

describe("isSocketAlive", () => {
  let tmpDir: string;
  let testSocketPath: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "alive-test-")));
    testSocketPath = join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true when a server is listening on the path", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(testSocketPath, resolve));

    try {
      const alive = await isSocketAlive(testSocketPath);
      expect(alive).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns false when no server is listening (ENOENT)", async () => {
    const alive = await isSocketAlive(testSocketPath);
    expect(alive).toBe(false);
  });

  it("returns false for a stale socket file (file exists, no listener)", async () => {
    // Create a regular file pretending to be a socket
    await writeFile(testSocketPath, "");
    const alive = await isSocketAlive(testSocketPath);
    expect(alive).toBe(false);
  });
});

describe("cleanStaleSocket", () => {
  let tmpDir: string;
  let testSocketPath: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "clean-test-")));
    testSocketPath = join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes a stale socket file and returns true", async () => {
    await writeFile(testSocketPath, "");
    const removed = await cleanStaleSocket(testSocketPath);
    expect(removed).toBe(true);

    // Verify file is gone
    await expect(stat(testSocketPath)).rejects.toThrow();
  });

  it("returns false and leaves socket intact when a live server is listening", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(testSocketPath, resolve));

    try {
      const removed = await cleanStaleSocket(testSocketPath);
      expect(removed).toBe(false);

      // Socket file should still exist
      const stats = await stat(testSocketPath);
      expect(stats).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it("returns true (no-op) when socket file does not exist", async () => {
    const removed = await cleanStaleSocket(testSocketPath);
    expect(removed).toBe(true);
  });
});
