import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { detectIde, launchIde, writeWorktreeTasksFile, reloadIdeWindow, openDaemonLogTerminal } from "../src/ide.js";

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
    expect(detectIde()).toEqual({ command: "code", uriScheme: "vscode" });
  });

  it("detects VS Code Insiders via __CFBundleIdentifier", () => {
    process.env.__CFBundleIdentifier = "com.microsoft.VSCodeInsiders";
    expect(detectIde()).toEqual({ command: "code-insiders", uriScheme: "vscode-insiders" });
  });

  it("detects Antigravity via __CFBundleIdentifier", () => {
    process.env.__CFBundleIdentifier = "com.google.antigravity";
    expect(detectIde()).toEqual({ command: "agy", uriScheme: "antigravity" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for VS Code", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "code", uriScheme: "vscode" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for VS Code Insiders", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Visual Studio Code Insiders.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "code-insiders", uriScheme: "vscode-insiders" });
  });

  it("falls back to VSCODE_GIT_ASKPASS_NODE for Antigravity", () => {
    process.env.VSCODE_GIT_ASKPASS_NODE =
      "/Applications/Antigravity.app/Contents/MacOS/Electron";
    expect(detectIde()).toEqual({ command: "agy", uriScheme: "antigravity" });
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
    expect(detectIde()).toEqual({ command: "agy", uriScheme: "antigravity" });
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

  it("returns 'created' with worktree session task", async () => {
    const status = await writeWorktreeTasksFile(tmpDir, "my-feature");
    expect(status).toBe("created");

    const content = await readFile(
      join(tmpDir, ".vscode", "tasks.json"),
      "utf-8",
    );
    const parsed = JSON.parse(content);

    expect(parsed.version).toBe("2.0.0");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].label).toBe("Worktree: my-feature");
    expect(parsed.tasks[0].command).toBe("tmux attach -t my-feature");
  });

  it("creates 2 tasks when repoRoot is provided (heartbeat + worktree session)", async () => {
    const status = await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo");
    expect(status).toBe("created");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].label).toBe("Heartbeat: my-feature");
    expect(parsed.tasks[1].label).toBe("Worktree: my-feature");
  });

  it("heartbeat task contains correct repo-root and worktree args", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);
    const hbTask = parsed.tasks.find((t: { label: string }) => t.label === "Heartbeat: my-feature");

    expect(hbTask).toBeTruthy();
    expect(hbTask.command).toContain('--repo-root "/fake/repo"');
    expect(hbTask.command).toContain('--worktree "my-feature"');
    expect(hbTask.command).toContain("heartbeat.js");
  });

  it("heartbeat task has reveal=never and isBackground=true", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);
    const hbTask = parsed.tasks.find((t: { label: string }) => t.label === "Heartbeat: my-feature");

    expect(hbTask.presentation.reveal).toBe("never");
    expect(hbTask.isBackground).toBe(true);
    expect(hbTask.runOptions.runOn).toBe("folderOpen");
  });

  it("does not create heartbeat task when repoRoot is omitted (backward compat)", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks.some((t: { label: string }) => t.label.startsWith("Heartbeat:"))).toBe(false);
  });

  it("heartbeat task is idempotent", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo");
    const status = await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo");
    expect(status).toBe("unchanged");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);
    const hbTasks = parsed.tasks.filter((t: { label: string }) => t.label === "Heartbeat: my-feature");
    expect(hbTasks).toHaveLength(1);
  });

  it("creates 3 tasks when visible=true (worktree session + heartbeat + daemon monitor)", async () => {
    const status = await writeWorktreeTasksFile(tmpDir, "my-feature", tmpDir, true);
    expect(status).toBe("created");

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.tasks[0].label).toBe("Heartbeat: my-feature");
    expect(parsed.tasks[1].label).toBe("Worktree: my-feature");
    expect(parsed.tasks[2].label).toBe("Daemon Monitor");
  });

  it("daemon monitor task attaches to the correct tmux session", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", tmpDir, true);

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);
    const monitorTask = parsed.tasks.find((t: { label: string }) => t.label === "Daemon Monitor");

    expect(monitorTask).toBeTruthy();
    expect(monitorTask.command).toMatch(/^tmux attach -t wtsu_daemon_[0-9a-f]{12}$/);
    expect(monitorTask.presentation.reveal).toBe("always");
    expect(monitorTask.presentation.panel).toBe("dedicated");
    expect(monitorTask.runOptions.runOn).toBe("folderOpen");
  });

  it("heartbeat task has reveal=always when visible=true", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", tmpDir, true);

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);
    const hbTask = parsed.tasks.find((t: { label: string }) => t.label === "Heartbeat: my-feature");

    expect(hbTask.presentation.reveal).toBe("always");
  });

  it("does not create daemon monitor when visible=false", async () => {
    await writeWorktreeTasksFile(tmpDir, "my-feature", "/fake/repo", false);

    const content = await readFile(join(tmpDir, ".vscode", "tasks.json"), "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks.some((t: { label: string }) => t.label === "Daemon Monitor")).toBe(false);
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

describe("openDaemonLogTerminal", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  it("spawns 'open' with the correct vscode URI", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    openDaemonLogTerminal("vscode", "/tmp/wtsu-501/myrepo-abc12345.daemon.log", "myrepo");

    expect(mockSpawn).toHaveBeenCalledWith(
      "open",
      [expect.stringContaining("vscode://open.in-terminal?config=")],
      { detached: true, stdio: "ignore" },
    );
    expect(mockUnref).toHaveBeenCalled();
  });

  it("spawns with antigravity URI when scheme is antigravity", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    openDaemonLogTerminal("antigravity", "/tmp/wtsu-501/myrepo-abc12345.daemon.log", "myrepo");

    const uri = mockSpawn.mock.calls[0][1][0] as string;
    expect(uri).toMatch(/^antigravity:\/\/open\.in-terminal\?config=.+&encoded=1$/);
  });

  it("encodes config with correct fields and quoted path", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    openDaemonLogTerminal("vscode", "/tmp/wtsu-501/myrepo-abc12345.daemon.log", "myrepo");

    const uri = mockSpawn.mock.calls[0][1][0] as string;
    const configParam = uri.split("config=")[1].split("&")[0];
    const decoded = JSON.parse(decodeURIComponent(Buffer.from(configParam, "base64").toString()));

    expect(decoded.command).toContain("tail -F");
    expect(decoded.command).toContain("myrepo-abc12345.daemon.log");
    expect(decoded.name).toContain("myrepo");
    expect(decoded.color).toBe("cyan");
    expect(decoded.autoFocus).toBe(false);
  });

  it("spawns with vscode-insiders URI", () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValueOnce({ unref: mockUnref } as never);

    openDaemonLogTerminal("vscode-insiders", "/tmp/wtsu-501/myrepo-abc12345.daemon.log", "myrepo");

    const uri = mockSpawn.mock.calls[0][1][0] as string;
    expect(uri).toMatch(/^vscode-insiders:\/\/open\.in-terminal/);
  });
});
