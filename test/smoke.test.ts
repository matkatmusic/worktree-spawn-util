import { describe, it, expect } from "vitest";
import * as lib from "../src/index.js";

describe("worktree-spawn-util", () => {
  it("loads the module without errors", () => {
    expect(lib).toBeDefined();
  });
});

/*
TODO: 
- make tasks.json spawn this app.
- if a worktree folder with name <> doesn't exist, 
- create a git worktree based on the user's preferrened name
- enter that worktree folder. 
- open AGY window in that worktree
- close AGY window: delete worktree folder, kill tmux session.
- spawn claude in terminal
- spawn tmux in terminal

*/