# Coding agent guide

This repo is a deterministic, restartable task runner implemented as an extension to the pi coding agent. 
It uses Jujutsu workspaces (`jj`) for per-task isolation, and `tk` for ticket management.


A previous version of this idea, which was a typescript script, is at: /Users/colin/dev/task2/task.ts
Use this repo for examples of the required user interaction.

## Entry point

- Run the tool with `/task` (no subcommands) inside the agent.
- Must be inside a Jujutsu workspace (`jj root` must succeed).
- The tool requires these commands on `PATH`: `jj`, `tk`, `jq`.
- Run `tk --help` to see how that tool works if required.

## Typical workflow

- From the main repo workspace: `/task`
  - Checks for any jj workspaces with no `in_progress` tasks and unmerged jj commits.
  - While mergeable workspaces found:
    - Prompt the user to select workspaces to merge
    - When the user selects, merge the workspace
    - If successful, prompt whether it should be deleted
    - Follow example in maybeMergeDoneWorkspace from task.ts for the general flow, adapting to pi-specific internals.
  - Prompts to choose a top-level task from `tk ready`, filtered to exclude tasks that are `in_progress` in any workspace.
  - Creates a task workspace at `~/.workspaces/<task-id>/<repo-name>`.
  - In that workspace, sets the task to `in_progress`.
- From the task workspace: `/task`
  - The task workspace must contain exactly one task from `tk query 'select(.status == "in_progress")'` (otherwise the command exits for manual cleanup).
  - The user will drive the changes in this workspace until the task is marked closed
 
## Working conventions (important)

- Prefer minimal edits focused on the active subtask; leave changes uncommitted unless explicitly asked to commit (the runner commits at the end).
- Keep the whole extension in a single task.ts file in this directory.

Documentation is at:

Extensions: /Users/colin/dev/pi-mono/packages/coding-agent/docs/extensions.md
TUI: /Users/colin/dev/pi-mono/packages/coding-agent/docs/tui.md

Examples of existing extensions are at:

/Users/colin/dev/pi-mono/packages/coding-agent/examples/extensions

