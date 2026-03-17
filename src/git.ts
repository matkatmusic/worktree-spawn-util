// git module — worktree CRUD, branch operations, merge detection

import { simpleGit } from "simple-git";
import { join } from "node:path";
import { access, mkdir } from "node:fs/promises";
import type { Logger } from "./logger.js";

export type WorktreeInfo = {
  path: string;
  branch: string;
};

/** Result of the repo picker — the validated root of a git repository. */
export type RepoSelection = {
  repoRoot: string;
  isValid: boolean;
};

/** Validate that a folder is a git repo and resolve to its root. */
export async function validateRepo(folderPath: string, logger?: Logger): Promise<RepoSelection> {
  logger?.log("[git] validateRepo: " + folderPath);
  const git = simpleGit(folderPath);
  const isRepo = await git.checkIsRepo();
  const root = isRepo
    ? (await git.revparse(["--show-toplevel"])).trim()
    : folderPath;
  logger?.log("[git] validateRepo result: isValid=" + isRepo + " root=" + root);
  return { repoRoot: root, isValid: isRepo };
}

/** Parse `git worktree list --porcelain` output into WorktreeInfo[]. */
export function parseWorktreeList(raw: string, logger?: Logger): WorktreeInfo[] {
  logger?.log("[git] parseWorktreeList: " + raw);
  return raw
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch "));
      return {
        path: pathLine ? pathLine.slice("worktree ".length) : "",
        branch: branchLine ? branchLine.slice("branch refs/heads/".length) : "",
      };
    });
}

/**
 * Create a git worktree inside `<repoRoot>/.worktrees/<worktreeName>`.
 *
 * Idempotent: if the worktree already exists with the correct branch, returns it.
 * Throws if the branch is checked out elsewhere or the directory exists but isn't a worktree.
 */
export async function createWorktree(
  repoRoot: string,
  worktreeName: string,
  logger?: Logger,
): Promise<WorktreeInfo> {
  const git = simpleGit(repoRoot);
  const worktreePath = join(repoRoot, ".worktrees", worktreeName);
  logger?.log("[git] createWorktree: " + worktreePath);

  // Check existing worktrees
  const listRaw = await git.raw(["worktree", "list", "--porcelain"]);
  const existing = parseWorktreeList(listRaw, logger);

  // Idempotent: already exists with correct path + branch
  const exactMatch = existing.find(
    (wt) => wt.path === worktreePath && wt.branch === worktreeName,
  );
  if (exactMatch) {
    logger?.log("[git] createWorktree: idempotent match for " + worktreeName);
    return { path: exactMatch.path, branch: exactMatch.branch };
  }

  // Branch checked out in a different worktree
  const branchConflict = existing.find((wt) => wt.branch === worktreeName);
  if (branchConflict) {
    throw new Error(
      `Branch "${worktreeName}" is already checked out in worktree: ${branchConflict.path}`,
    );
  }

  // Directory exists on disk but isn't a known worktree
  let dirExists = false;
  try {
    await access(worktreePath);
    dirExists = true;
  } catch (err: unknown) {
    if (
      !(err instanceof Error && "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT")
    ) {
      throw err;
    }
  }
  if (dirExists) {
    throw new Error(
      `Directory exists but is not a worktree for this repo: ${worktreePath}`,
    );
  }

  // Ensure .worktrees directory exists
  await mkdir(join(repoRoot, ".worktrees"), { recursive: true });

  // Create worktree — reuse existing branch or create new one
  const branches = await git.branchLocal();
  if (branches.all.includes(worktreeName)) {
    logger?.log("[git] createWorktree: reusing existing branch " + worktreeName);
    await git.raw(["worktree", "add", worktreePath, worktreeName]);
  } else {
    logger?.log("[git] createWorktree: creating new branch " + worktreeName);
    await git.raw(["worktree", "add", "-b", worktreeName, worktreePath]);
  }

  return { path: worktreePath, branch: worktreeName };
}

/** Check if a branch is fully merged into a parent branch. */
export async function isBranchMerged(
  repoRoot: string,
  branch: string,
  parentBranch: string,
  logger?: Logger,
): Promise<boolean> {
  logger?.log("[git] isBranchMerged: checking " + branch + " against " + parentBranch);
  const git = simpleGit(repoRoot);
  const merged = await git.raw(["branch", "--merged", parentBranch]);
  // git branch --merged prefixes with "* " (current), "+ " (worktree), or "  " (other)
  const mergedBranches = merged.split("\n").map((l) => l.replace(/^[*+]?\s+/, "").trim()).filter(Boolean);
  const result = mergedBranches.includes(branch);
  logger?.log("[git] isBranchMerged: " + branch + " merged=" + result);
  return result;
}

/** Check if a branch has commits beyond a given commit hash. */
export async function hasNewCommits(
  repoRoot: string,
  branch: string,
  parentCommit: string,
  logger?: Logger,
): Promise<boolean> {
  logger?.log("[git] hasNewCommits: checking " + branch + " since " + parentCommit.slice(0, 7));
  const git = simpleGit(repoRoot);
  const log = await git.raw(["log", `${parentCommit}..${branch}`, "--oneline"]);
  const result = log.trim().length > 0;
  logger?.log("[git] hasNewCommits: " + branch + " hasNew=" + result);
  return result;
}

/** Check if all uncommitted changes in a worktree are only in .claude/ or .vscode/. */
export async function onlyIgnorableChanges(worktreePath: string, logger?: Logger): Promise<boolean> {
  logger?.log("[git] onlyIgnorableChanges: checking " + worktreePath);
  const git = simpleGit(worktreePath);
  const status = await git.raw(["status", "--porcelain"]);
  const lines = status.trim().split("\n").filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    logger?.log("[git] onlyIgnorableChanges: no changes");
    return true;
  }

  const result = lines.every((line) => {
    // status --porcelain format: XY <path> or XY <path> -> <path>
    const filePath = line.slice(3).split(" -> ")[0];
    return filePath.startsWith(".claude/") || filePath.startsWith(".vscode/");
  });
  logger?.log("[git] onlyIgnorableChanges: ignorable=" + result + " (" + lines.length + " files)");
  return result;
}

/** Remove a worktree and delete its branch. */
export async function removeWorktreeAndBranch(
  repoRoot: string,
  worktreeName: string,
  logger?: Logger,
): Promise<void> {
  logger?.log("[git] removeWorktreeAndBranch: " + worktreeName);
  const git = simpleGit(repoRoot);
  await git.raw(["worktree", "remove", "--force", worktreeName]);
  try {
    await git.raw(["branch", "-D", worktreeName]);
    logger?.log("[git] Deleted branch: " + worktreeName);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`[git] Could not delete branch "${worktreeName}": ${msg}`);
  }
}
