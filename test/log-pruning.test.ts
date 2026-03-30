import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneLogFile } from "../src/log-pruning.js";

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

describe("pruneLogFile", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "prune-test-"));
    logPath = join(tmpDir, "test.daemon.log");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when file does not exist", () => {
    expect(() => pruneLogFile(logPath, 14)).not.toThrow();
  });

  it("retains all lines when all are recent", async () => {
    const ts = daysAgo(1);
    const content = `[${ts}] [LOG] recent line\n`;
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result).toContain("recent line");
  });

  it("removes all lines when all are old", async () => {
    const ts = daysAgo(30);
    const content = `[${ts}] [LOG] old line\n`;
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result.trim()).toBe("");
  });

  it("keeps new session, removes old session", async () => {
    const oldTs = daysAgo(20);
    const newTs = daysAgo(2);
    const content = [
      `=== SESSION START [${oldTs}] ===`,
      `repo: /old/repo`,
      `========================`,
      `[${oldTs}] [LOG] old event`,
      `=== SESSION START [${newTs}] ===`,
      `repo: /new/repo`,
      `========================`,
      `[${newTs}] [LOG] new event`,
    ].join("\n") + "\n";
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result).not.toContain("old event");
    expect(result).toContain("new event");
    expect(result).toContain(`SESSION START [${newTs}]`);
  });

  it("removes entire header block when header timestamp is old", async () => {
    const oldTs = daysAgo(20);
    const content = [
      `=== SESSION START [${oldTs}] ===`,
      `worktree: (pending first heartbeat)`,
      `repo: /some/repo`,
      `socket: /tmp/wtsu-501/abc.sock`,
      `========================`,
    ].join("\n") + "\n";
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result).not.toContain("SESSION START");
    expect(result).not.toContain("/some/repo");
  });

  it("retains lines without timestamps", async () => {
    const newTs = daysAgo(1);
    const content = [
      `some orphaned line with no timestamp`,
      `[${newTs}] [LOG] recent line`,
    ].join("\n") + "\n";
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result).toContain("orphaned line");
  });

  it("keeps lines exactly 14 days old (boundary)", async () => {
    const ts = daysAgo(14);
    const content = `[${ts}] [LOG] boundary line\n`;
    await writeFile(logPath, content);
    pruneLogFile(logPath, 14);
    const result = await readFile(logPath, "utf-8");
    expect(result).toContain("boundary line");
  });

  it("uses atomic write (no temp file left behind)", async () => {
    const ts = daysAgo(1);
    await writeFile(logPath, `[${ts}] [LOG] line\n`);
    pruneLogFile(logPath, 14);
    const tmpFileContent = await readFile(logPath + ".tmp", "utf-8").catch(() => null);
    expect(tmpFileContent).toBeNull();
  });
});
