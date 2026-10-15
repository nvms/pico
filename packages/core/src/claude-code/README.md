# Claude Code engine

Runs a pico session's turns through Claude Code, on the user's own Claude subscription, instead of through a model API.

## Why

A Claude subscription can't be used as an API key. The supported way to use it is the `claude` command. This engine drives that command headless, so a pico session (and any kagent agent) can use Claude models, with Claude Code's own tools, at subscription cost. pico still owns the session: its log, transcript, peers, questions and host tools work the same as with any other model.

## How

`engines.js` is the seam. When a session's model has the provider `claude-code`, the controller calls this engine's `run` and `compact` in place of `runTurn` and `compactHistory`. The engine takes the same arguments, emits the same stream events and returns provider-shaped messages, so nothing downstream knows the difference.

| File | Role |
| --- | --- |
| `engine.js` | One long-lived `claude` process per pico session; plays a turn, returns pico history |
| `cli.js` | Spawns `claude -p` with stream-json in and out; the control requests (initialize, interrupt) |
| `translate.js` | Pure mapping: Claude events and tools to pico's, pico history to Claude input |
| `bridge.js`, `mcp-server.js` | pico's own tools (ask_user, peers, wake-ups, host tools such as kagent's terminals and browser) offered to Claude Code as the MCP server `pico` |
| `models.js` | The model catalog (`claude-code/fable`, `opus`, `sonnet`, `haiku`) and the sign-in check |

**History.** pico's log is the source of truth, and Claude Code's context is a cache of it. After each turn the engine records a fingerprint of the history Claude Code holds, and saves it with the session as an `engine_state` event, together with the Claude session id. On the next turn:

- if pico's history is that history plus new messages, only the new messages are sent;
- if pico's history changed underneath it (rewind, steer, clear, compaction, or a conversation started with another model), a fresh Claude session starts with the earlier conversation as a transcript;
- after a restart, the saved Claude session is resumed with `--resume`, and a forked pico session forks it with `--fork-session`.

**Tools.** Claude Code's tools are recorded as pico's equivalents (`Bash` as `bash`, `Edit` as `edit`, with diffs), so the transcript renders them and rewind can undo Claude's edits. pico tools that Claude Code has its own version of (read, edit, bash, agents and so on) are not offered over the bridge.

## Rules

- **Subscription only.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child's environment. Either one would make Claude Code bill the API, silently. The models only appear when `claude auth status` reports a claude.ai sign-in.
- **No permission prompts.** Claude Code runs with `--dangerously-skip-permissions`, as pico does. Questions go through pico's `ask_user`, so `AskUserQuestion` is disallowed, and so are `EnterWorktree` and `ExitWorktree` because the host owns worktrees.
- **Compaction.** Claude Code compacts its own context, so pico doesn't auto-compact these sessions. A manual compact summarizes with the same model and restarts the Claude session from that summary.

## Not covered

- What happens inside a Claude `Task` subagent: only the call and its result are shown.
- pico's own subagents and deliberation. Claude Code has its own.
- The subscription's rate-limit status.

## Checking it

`test/claude-code.test.js` runs the engine against a scripted Claude Code; no model is called. `node scripts/claude-code-smoke.js [model]` runs real turns through the installed `claude` (haiku by default): an edit, bash, ask_user, an interrupt, and a resume after restart. Run it after upgrading Claude Code, since the stream-json control protocol is the Agent SDK's and isn't separately documented.
