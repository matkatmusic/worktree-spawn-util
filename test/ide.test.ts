import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { detectIde, launchIde, writeWorktreeTasksFile, reloadIdeWindow } from "../src/ide/index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => cb(null, "", "")),
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

  it("returns 'created' with both Claude and tmux tasks", async () => {
    const status = await writeWorktreeTasksFile(tmpDir, "my-feature");
    expect(status).toBe("created");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.version).toBe("2.0.0");
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].label).toBe("Launch Claude");
    expect(parsed.tasks[0].runOptions.runOn).toBe("folderOpen");
    expect(parsed.tasks[0].isBackground).toBe(true);
    expect(parsed.tasks[1].label).toBe("tmux: my-feature");
    expect(parsed.tasks[1].command).toBe("tmux new-session -A -s my-feature");
  });

  it("interpolates worktree name into group fields", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.tasks[0].presentation.group).toBe("worktree-my-feature");
    expect(parsed.tasks[1].presentation.group).toBe("worktree-my-feature");
  });

  it("returns 'updated' and preserves existing tasks", async () => {
    const existing = {
      version: "2.0.0",
      tasks: [{ label: "Build", type: "shell", command: "npm run build" }],
    };
    await mkdir(join(tmpDir, ".vscode"), { recursive: true });
    await writeFile(
      join(tmpDir, ".vscode", "tasks.json"),
      JSON.stringify(existing),
    );

    const status = await writeWorktreeTasksFile(tmpDir, "my-feature");
    expect(status).toBe("updated");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[0].label).toBe("Build");
    expect(parsed.tasks[1].label).toBe("Launch Claude");
    expect(parsed.tasks[2].label).toBe("tmux: my-feature");
  });

  it("returns 'unchanged' if both tasks already exist", async () => {
    const existing = {
      version: "2.0.0",
      tasks: [
        { label: "Launch Claude", type: "shell", command: "claude" },
        { label: "tmux: my-feature", type: "shell", command: "tmux new-session -A -s my-feature" },
      ],
    };
    await mkdir(join(tmpDir, ".vscode"), { recursive: true });
    const originalContent = JSON.stringify(existing);
    await writeFile(
      join(tmpDir, ".vscode", "tasks.json"),
      originalContent,
    );

    const status = await writeWorktreeTasksFile(tmpDir, "my-feature");
    expect(status).toBe("unchanged");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    expect(content).toBe(originalContent);
  });
});

describe("reloadIdeWindow", () => {
  const mockExecFile = vi.mocked(execFile);

  beforeEach(() => {
    mockExecFile.mockClear();
  });

  it("calls osascript with the bundle ID", async () => {
    await reloadIdeWindow("com.google.antigravity");

    expect(mockExecFile).toHaveBeenCalledWith(
      "osascript",
      expect.arrayContaining([expect.stringContaining("com.google.antigravity")]),
      expect.any(Function),
    );
  });

  it("logs warning on failure instead of throwing", async () => {
    mockExecFile.mockImplementationOnce((_cmd, _args, cb) => {
      (cb as Function)(new Error("accessibility denied"), "", "");
      return undefined as never;
    });

    // Should not throw
    await expect(reloadIdeWindow("com.microsoft.VSCode")).resolves.toBeUndefined();
  });
});
