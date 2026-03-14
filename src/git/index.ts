// git module — worktree CRUD, branch operations, merge detection

import { simpleGit } from "simple-git";
import { join } from "node:path";
import { access, mkdir } from "node:fs/promises";

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
export async function validateRepo(folderPath: string): Promise<RepoSelection> {
  const git = simpleGit(folderPath);
  const isRepo = await git.checkIsRepo();
  const root = isRepo
    ? (await git.revparse(["--show-toplevel"])).trim()
    : folderPath;
  return { repoRoot: root, isValid: isRepo };
}

/** Parse `git worktree list --porcelain` output into WorktreeInfo[]. */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
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
): Promise<WorktreeInfo> {
  const git = simpleGit(repoRoot);
  const worktreePath = join(repoRoot, ".worktrees", worktreeName);

  // Check existing worktrees
  const listRaw = await git.raw(["worktree", "list", "--porcelain"]);
  const existing = parseWorktreeList(listRaw);

  // Idempotent: already exists with correct path + branch
  const exactMatch = existing.find(
    (wt) => wt.path === worktreePath && wt.branch === worktreeName,
  );
  if (exactMatch) {
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
    await git.raw(["worktree", "add", worktreePath, worktreeName]);
  } else {
    await git.raw(["worktree", "add", "-b", worktreeName, worktreePath]);
  }

  return { path: worktreePath, branch: worktreeName };
}
