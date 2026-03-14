import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { detectIde, launchIde, writeWorktreeTasksFile } from "../src/ide/index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const mockSpawn = vi.mocked(spawn);

describe("detectIde", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.__CFBundleIdentifier;
    delete process.env.VSCODE_GIT_ASKPASS_NODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("detects VS Code via __CFBundleIdentifier", () => {
    process.env.__CFBundleIdentifier = "com.microsoft.VSCode";
    expect(detectIde()).toEqual({ command: "code" });
  });

  it("detects VS Code Insiders via __CFBundleIdentifier", () => {
    process.env.__CFBundleIdentifier = "com.microsoft.VSCodeInsiders";
    expect(detectIde()).toEqual({ command: "code-insiders" });
  });

  it("detects Antigravity via __CFBundleIdentifier", () => {
    process.env.__CFBundleIdentifier = "com.google.antigravity";
    expect(detectIde()).toEqual({ command: "agy" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for VS Code", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "code" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for VS Code Insiders", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Visual Studio Code Insiders.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "code-insiders" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for Antigravity", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Antigravity.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "agy" });
  });

  it("returns null when no IDE env vars are set", () => {
    expect(detectIde()).toBeNull();
  });

  it("returns null for unknown bundle identifier", () => {
    process.env.__CFBundleIdentifier = "com.unknown.editor";
    expect(detectIde()).toBeNull();
  });

  it("prefers __CFBundleIdentifier over VSCODE_GIT_ASKPASS_NODE", () => {
    process.env.__CFBundleIdentifier = "com.google.antigravity";
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "agy" });
  });
});

describe("launchIde", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  it("spawns the IDE command detached with correct args", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    launchIde({ command: "code" }, "/tmp/worktree");

    expect(mockSpawn).toHaveBeenCalledWith("code", ["/tmp/worktree"], {
      detached: true,
      stdio: "ignore",
    });
    expect(mockUnref).toHaveBeenCalled();
  });

  it("spawns agy when configured", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    launchIde({ command: "agy" }, "/repos/my-project/.worktrees/feat");

    expect(mockSpawn).toHaveBeenCalledWith(
      "agy",
      ["/repos/my-project/.worktrees/feat"],
      { detached: true, stdio: "ignore" },
    );
    expect(mockUnref).toHaveBeenCalled();
  });
});

describe("writeWorktreeTasksFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wt-ide-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .vscode/tasks.json with Launch Claude task when file is missing", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.version).toBe("2.0.0");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].label).toBe("Launch Claude");
    expect(parsed.tasks[0].runOptions.runOn).toBe("folderOpen");
  });

  it("adds Launch Claude task to existing tasks.json preserving other tasks", async () => {
    const existing = {
      version: "2.0.0",
      tasks: [{ label: "Build", type: "shell", command: "npm run build" }],
    };
    await mkdir(join(tmpDir, ".vscode"), { recursive: true });
    await writeFile(
      join(tmpDir, ".vscode", "tasks.json"),
      JSON.stringify(existing),
    );

    await writeWorktreeTasksFile(tmpDir, "my-feature");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].label).toBe("Build");
    expect(parsed.tasks[1].label).toBe("Launch Claude");
  });

  it("skips if Launch Claude task already exists", async () => {
    const existing = {
      version: "2.0.0",
      tasks: [
        { label: "Launch Claude", type: "shell", command: "claude" },
      ],
    };
    await mkdir(join(tmpDir, ".vscode"), { recursive: true });
    const originalContent = JSON.stringify(existing);
    await writeFile(
      join(tmpDir, ".vscode", "tasks.json"),
      originalContent,
    );

    await writeWorktreeTasksFile(tmpDir, "my-feature");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    // File should be untouched
    expect(content).toBe(originalContent);
  });
});
