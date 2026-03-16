- [] add a launchable IDE task that prompts me to:
    - [x] pick a repo on my computer,
    - [x] enter a worktree name
    - [x] create the worktree in that repo, using the name provided by the user.
    - [x] opens a new IDE window in that worktree folder. 
    - [x] opens the integrated terminal in that IDE window, sets CWD to worktree chosen by user. 
    - [x] splits integrated terminal into 2 terminals
    - [x] spawns claude in plan mode in top terminal
    - [x] spawns tmux in bottom terminal    
    - [x] detect when the new ide window is closed
    - [x] kill the claude-tmux session when the IDE window is closed.
    - [ ] When the user closes the IDE window:  
        if ( (the Worktree branch was merged) OR (no commits were made in the worktree branch AND (the only changes are in the .claude folder OR the .vscode folder)) )
            - delete the worktree and branch
        else
            notify the user that the worktree has changes that need to be committed or stashed.

    
Future features (in order)
- [ ] when claude is spawned, name the conversation with the same name as the worktree.
- [ ] If worktree-spawn-util is installed as a submodule in another repo, do not prompt for the repo folder when pick-repo is invoked: use the parent repo as the repo folder.  This requires detecting in pick-repo if the script is running inside a folder that is a submodule of another repo. 