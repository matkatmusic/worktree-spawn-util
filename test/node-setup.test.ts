import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isNodeProject, hasBuildScript, detectPackageManager, setupNodeProject } from "../src/node-setup.js";
import { Logger } from "../src/logger.js";

describe("isNodeProject", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "node-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true when package.json exists", async () => {
    await writeFile(join(tmpDir, "package.json"), "{}");
    expect(await isNodeProject(tmpDir)).toBe(true);
  });

  it("returns false when package.json does not exist", async () => {
    expect(await isNodeProject(tmpDir)).toBe(false);
  });
});

describe("hasBuildScript", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "node-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true when scripts.build exists", async () => {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { build: "tsc" },
    }));
    expect(await hasBuildScript(tmpDir)).toBe(true);
  });

  it("returns false when scripts.build is missing", async () => {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest" },
    }));
    expect(await hasBuildScript(tmpDir)).toBe(false);
  });

  it("returns false when scripts key is missing", async () => {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    expect(await hasBuildScript(tmpDir)).toBe(false);
  });

  it("returns false when package.json is invalid JSON", async () => {
    await writeFile(join(tmpDir, "package.json"), "not json");
    expect(await hasBuildScript(tmpDir)).toBe(false);
  });

  it("returns false when package.json does not exist", async () => {
    expect(await hasBuildScript(tmpDir)).toBe(false);
  });
});

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "node-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects pnpm from pnpm-lock.yaml", async () => {
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "");
    const pm = await detectPackageManager(tmpDir);
    expect(pm.command).toBe("pnpm");
    expect(pm.args).toEqual(["install"]);
  });

  it("detects yarn from yarn.lock", async () => {
    await writeFile(join(tmpDir, "yarn.lock"), "");
    const pm = await detectPackageManager(tmpDir);
    expect(pm.command).toBe("yarn");
    expect(pm.args).toEqual(["install"]);
  });

  it("uses npm ci when package-lock.json exists", async () => {
    await writeFile(join(tmpDir, "package-lock.json"), "{}");
    const pm = await detectPackageManager(tmpDir);
    expect(pm.command).toBe("npm");
    expect(pm.args).toEqual(["ci"]);
  });

  it("falls back to npm install when no lock file exists", async () => {
    const pm = await detectPackageManager(tmpDir);
    expect(pm.command).toBe("npm");
    expect(pm.args).toEqual(["install"]);
  });

  it("prefers pnpm over yarn when both lock files exist", async () => {
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "");
    await writeFile(join(tmpDir, "yarn.lock"), "");
    const pm = await detectPackageManager(tmpDir);
    expect(pm.command).toBe("pnpm");
  });
});

describe("setupNodeProject", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "node-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips silently when no package.json exists", async () => {
    const logger = new Logger(undefined, { silent: true });
    await setupNodeProject(tmpDir, logger);
    // Should complete without error
  });

  it("runs npm install and creates package-lock.json", async () => {
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      version: "1.0.0",
    }));
    const logger = new Logger(undefined, { silent: true });
    await setupNodeProject(tmpDir, logger);

    // npm install creates package-lock.json even with no deps
    await expect(access(join(tmpDir, "package-lock.json"))).resolves.toBeUndefined();
  }, 30_000);
});
