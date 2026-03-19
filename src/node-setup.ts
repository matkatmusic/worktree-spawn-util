// node-setup module — detect Node projects and run install/build in worktrees

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

/** Check if a directory contains a package.json. */
export async function isNodeProject(dir: string): Promise<boolean> {
  try {
    await access(join(dir, "package.json"));
    return true;
  } catch {
    return false;
  }
}

/** Check if the project's package.json has a "build" script. */
export async function hasBuildScript(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    return !!pkg.scripts?.build;
  } catch {
    return false;
  }
}

/** Detect which package manager to use based on lock files. */
export async function detectPackageManager(dir: string): Promise<{ command: string; args: string[] }> {
  try {
    await access(join(dir, "pnpm-lock.yaml"));
    return { command: "pnpm", args: ["install"] };
  } catch { /* not pnpm */ }

  try {
    await access(join(dir, "yarn.lock"));
    return { command: "yarn", args: ["install"] };
  } catch { /* not yarn */ }

  try {
    await access(join(dir, "package-lock.json"));
    return { command: "npm", args: ["ci"] };
  } catch { /* no lock file */ }

  return { command: "npm", args: ["install"] };
}

/** Run a command with inherited stdio, returning success/failure. */
function runCommand(command: string, args: string[], cwd: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("close", (code) => {
      resolve({ success: code === 0, error: code !== 0 ? `Exit code ${code}` : undefined });
    });
    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Detect if worktree is a Node project and run install + build.
 * Failures warn but do not block — the IDE will still open.
 */
export async function setupNodeProject(worktreePath: string, logger?: Logger): Promise<void> {
  if (!(await isNodeProject(worktreePath))) return;

  const pm = await detectPackageManager(worktreePath);
  logger?.log(`[pick-repo] Node project detected — running ${pm.command} ${pm.args.join(" ")}...`);

  const installResult = await runCommand(pm.command, pm.args, worktreePath);
  if (!installResult.success) {
    logger?.warn(`[pick-repo] ${pm.command} ${pm.args.join(" ")} failed: ${installResult.error}`);
    return;
  }
  logger?.log(`[pick-repo] ${pm.command} ${pm.args.join(" ")} complete`);

  if (await hasBuildScript(worktreePath)) {
    const buildCmd = pm.command === "npm" ? "npm" : pm.command;
    const buildArgs = buildCmd === "npm" ? ["run", "build"] : ["build"];
    logger?.log(`[pick-repo] Build script found — running ${buildCmd} ${buildArgs.join(" ")}...`);

    const buildResult = await runCommand(buildCmd, buildArgs, worktreePath);
    if (!buildResult.success) {
      logger?.warn(`[pick-repo] ${buildCmd} ${buildArgs.join(" ")} failed: ${buildResult.error}`);
      return;
    }
    logger?.log(`[pick-repo] Build complete`);
  }
}
