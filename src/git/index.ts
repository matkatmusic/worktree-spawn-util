// git module — worktree CRUD, branch operations, merge detection

import { simpleGit } from "simple-git";

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
