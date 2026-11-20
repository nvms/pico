# Claude Code

Runs a pico session's turns through Claude Code, on the user's own Claude subscription, instead of through a model API.

## Why

A Claude subscription can't be used as an API key. The supported way to use it is the `claude` command. pico drives that command headless, so a pico session (and any host's agent) can use Claude models, with Claude Code's own tools, at subscription cost. pico still owns the session: its log, transcript, peers, questions and host tools work the same as with any other model.

## How

Claude Code is one of the agents pico reaches over ACP (`../acp/README.md`). The adapter makes it an ACP agent, and the ACP engine plays pico's turns through it.

| File | Role |
| --- | --- |
| `adapter.js` | Claude Code as an ACP agent: one `claude` process per session, its stream-json as ACP updates |
| `cli.js` | Spawns `claude -p` with stream-json in and out; the control requests (initialize, interrupt) |
| `translate.js` | Pure mapping: Claude's tools, results, usage and content to ACP's |
| `engine.js` | The ACP engine over the adapter, with what pico tells Claude Code and the tools it does not offer it |
| `models.js` | The model catalog (`claude-code/fable`, `opus`, `sonnet`, `haiku`) and the sign-in check |
| `token.js` | The long-lived token Claude Code runs with, where pico keeps one |

**Sessions.** An ACP session's id is Claude Code's own session id (`--session-id`), so a session resumes with `--resume` after any restart and forks with `--fork-session`. Changing the model or effort restarts the process on the same session.

**Tools.** Claude's tool calls carry the pico tool each amounts to (`Bash` as `bash`, `Edit` as `edit`), and an edit's update carries the whole file before and after, so the transcript shows the diff and rewind can undo it. pico tools Claude Code has its own version of are not offered over the bridge; pico's subagent tool is offered only for other providers' models.

**Sign-in.** Claude Code runs on its own claude.ai login, or on a long-lived token from `claude setup-token` (`../sign-in/claude-code.js`), which pico keeps in its home or a host passes as `CLAUDE_CODE_OAUTH_TOKEN`.

## Rules

- **Subscription only.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child's environment. Either one would make Claude Code bill the API, silently.
- **No permission prompts.** Claude Code runs with `--dangerously-skip-permissions`, as pico does. Questions go through pico's `ask_user`, so `AskUserQuestion` is disallowed, and so are `EnterWorktree` and `ExitWorktree` because the host owns worktrees.
- **Compaction.** Claude Code compacts its own context, so pico doesn't auto-compact these sessions. A manual compact summarizes with the same model in a bare session.
- **Subagents.** Claude's subagents show in pico's activity list, with their tool calls and reports. Background tasks are turned off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`): work that outlives a turn would be invisible to pico.

## Checking it

`test/claude-code.test.js` runs the engine and adapter against a scripted Claude Code; no model is called. `node scripts/claude-code-smoke.js [model]` runs real turns through the installed `claude` (haiku by default): an edit, bash, ask_user, an interrupt, parallel subagents, and a resume after restart. Run it after upgrading Claude Code, since the stream-json control protocol is the Agent SDK's and isn't separately documented.
