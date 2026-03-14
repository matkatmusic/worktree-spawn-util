- [] add a launchable IDE task that prompts me to:
    - [x] pick a repo on my computer,
    - [x] enter a worktree name
    - [x] create the worktree in that repo, using the name provided by the user.
    - [x] opens a new IDE window in that worktree folder. 
    - [x] opens the integrated terminal in that IDE window, sets CWD to worktree chosen by user. 
    - [x] splits integrated terminal into 2 terminals
    - [x] spawns claude in plan mode in top terminal
    - [x] spawns tmux in bottom terminal    
    - [ ] detect when the new ide window is closed
    
Future features (in order)
    - [ ] When the IDE window is closed: 
        - [] kill the tmux session
        - if the worktree branch has been merged into the branch it was created from:
            - if the only changes remaining are in .vscode/tasks.json and .claude/settings.json and the http heartbeat stuff:
                - [] delete the worktree
            - else:
                notify the user that the worktree hasn't been removed because it has unstaged changes. 
- [ ] when claude is spawned, name the conversation with the same name as the worktree.