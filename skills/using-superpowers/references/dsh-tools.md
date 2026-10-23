# DeepSeek Harness (DSH) Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "invoke a skill"). On DSH those actions resolve to the tools below. Trust your live tool list over this table when the two disagree.

| Action skills request | DSH tool |
| --- | --- |
| Read / create / edit a file | `read`, `write`, `edit` |
| Find files by path, search file contents | `glob`, `grep` |
| Run a shell command | `bash` (a fresh shell per call — no state carries over) |
| Invoke a skill | `skill` |
| Dispatch a subagent | `subagent` (clean context) or `subagent_fork` (inherits this conversation) |
| Track tasks ("create a todo", "mark complete") | `todo_write` |
| Ask your human partner a question | `ask_user_question` |
| Fetch a URL, search the web | `web_fetch`, `web_search` |
| Hand over a file deliverable | `present` |
| Fan work out across many subagents | `workflow` |
| Leave plan mode | `exit_plan_mode` (only while plan mode is active) |

## Skill names

DSH registers skills by their **bare name**: `brainstorming`, `writing-plans`, `test-driven-development`. Where a skill says to invoke `superpowers:writing-plans` (or names the `Skill` tool), call the `skill` tool with `writing-plans` and no namespace prefix. The session catalog carries each skill's name and description; call `skill` with the exact name before acting, and do not load a `SKILL.md` with `read` when the `skill` tool can load it.

A user can also invoke a skill directly with `/brainstorming`; that content arrives in the conversation, so do not load it a second time.

## Subagents

- `subagent` starts a child with a clean context: it sees only the prompt you write. This is the default implementer for `subagent-driven-development` — include the complete task, the file paths, and the acceptance criteria, because the child does not inherit your todo list, your loaded skills, or this conversation.
- `subagent_fork` starts a child seeded with this conversation. Use it for reviewers and fix rounds that need the history.
- **Parallel dispatch** is several calls in one assistant message; they run concurrently. Use `workflow` when the fan-out is scripted (many items through the same pipeline) rather than a handful of hand-written children.
- Lifecycle: `list_agents`, `send_message` (steer a running child, or continue one after it finishes), `interrupt_agent`. There is no `Task(subagent_type=…)` tool and no `close_agent`; a child's report reaches you as a message.
- Some children run while you keep working; you are notified when they finish rather than having to poll.

## Todos

`todo_write` replaces the whole list on every call: send every item with its current status. Keep exactly the items you are working on `in_progress`.

## Shell and sandbox

- `bash` runs with the session workspace as its working directory; pass `workdir` instead of `cd`, and quote variables.
- Long-running commands belong in the background (`run_in_background`) and are collected with `job_output`; kill them with `job_kill` when they stop mattering.
- The default file policy is `workspace-write`: writes outside the session workspace are denied by the sandbox, and a denial is a policy decision, not a bug to retry. This includes `git worktree add ../name` — keep worktrees inside the workspace. If a step genuinely needs to write elsewhere, say so and let your human partner widen access.

## Files and instruction precedence

- `write` and `edit` expect a prior `read` of the target in the session; `read` returns line numbers.
- Files found by `glob`/`grep` are cheaper than shelling out to `find`/`rg`.
- `AGENTS.md` (project chain plus `~/.dsh/AGENTS.md`) is loaded automatically at session start and outranks skills, as does a direct request from your human partner.
