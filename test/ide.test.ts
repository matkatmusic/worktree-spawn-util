import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { detectIde, launchIde } from "../src/ide/index.js";

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
