import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { parseWorktreeList, createWorktree } from "../src/git.js";

describe("parseWorktreeList", () => {
  it("parses normal worktree entries", () => {
    const raw = [
      "worktree /Users/me/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/repo/.worktrees/feature",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");

    expect(parseWorktreeList(raw)).toEqual([
      { path: "/Users/me/repo", branch: "main" },
      { path: "/Users/me/repo/.worktrees/feature", branch: "feature" },
    ]);
  });

  it("handles bare worktree (no branch line)", () => {
    const raw = "worktree /Users/me/repo\nbare\n\n";
    expect(parseWorktreeList(raw)).toEqual([
      { path: "/Users/me/repo", branch: "" },
    ]);
  });

  it("handles detached HEAD (no branch line)", () => {
    const raw = "worktree /Users/me/repo\nHEAD abc123\ndetached\n\n";
    expect(parseWorktreeList(raw)).toEqual([
      { path: "/Users/me/repo", branch: "" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("createWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    // realpath resolves macOS /var → /private/var symlink to match git's resolved paths
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "wt-test-")));
    const git = simpleGit(tmpDir);
    await git.init();
    await git.commit("init", { "--allow-empty": null });
  });

  afterEach(async () => {
    // Remove any worktrees before deleting the temp dir
    const git = simpleGit(tmpDir);
    const listRaw = await git.raw(["worktree", "list", "--porcelain"]);
    const worktrees = parseWorktreeList(listRaw);
    for (const wt of worktrees) {
      if (wt.path !== tmpDir) {
        await git.raw(["worktree", "remove", "--force", wt.path]);
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new worktree with a new branch", async () => {
    const result = await createWorktree(tmpDir, "my-feature");

    expect(result.path).toBe(join(tmpDir, ".worktrees", "my-feature"));
    expect(result.branch).toBe("my-feature");

    // Verify directory exists
    await expect(access(result.path)).resolves.toBeUndefined();

    // Verify branch is checked out in worktree
    const wtGit = simpleGit(result.path);
    const branch = (await wtGit.raw(["branch", "--show-current"])).trim();
    expect(branch).toBe("my-feature");
  });

  it("returns existing worktree idempotently", async () => {
    const first = await createWorktree(tmpDir, "my-feature");
    const second = await createWorktree(tmpDir, "my-feature");

    expect(second).toEqual(first);
  });

  it("throws when branch is checked out in a different worktree", async () => {
    await createWorktree(tmpDir, "my-feature");

    // Manually create a branch conflict scenario by moving the worktree
    // Instead, we test via the branch name conflict with the main worktree's branch
    const git = simpleGit(tmpDir);
    const mainBranch = (await git.raw(["branch", "--show-current"])).trim();

    await expect(createWorktree(tmpDir, mainBranch)).rejects.toThrow(
      "already checked out in worktree",
    );
  });

  it("reuses an existing branch that has no worktree", async () => {
    // Create a branch, then delete the worktree but keep the branch
    const git = simpleGit(tmpDir);
    await git.raw(["branch", "existing-branch"]);

    const result = await createWorktree(tmpDir, "existing-branch");
    expect(result.branch).toBe("existing-branch");

    const wtGit = simpleGit(result.path);
    const branch = (await wtGit.raw(["branch", "--show-current"])).trim();
    expect(branch).toBe("existing-branch");
  });

  it("throws when directory exists but is not a worktree", async () => {
    const { mkdir } = await import("node:fs/promises");
    const fakePath = join(tmpDir, ".worktrees", "fake");
    await mkdir(fakePath, { recursive: true });

    await expect(createWorktree(tmpDir, "fake")).rejects.toThrow(
      "not a worktree",
    );
  });
});
