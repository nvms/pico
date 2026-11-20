# ACP

pico speaks the Agent Client Protocol (ACP) on both sides. Every coding agent pico drives is reached as an ACP agent, and pico itself is one, for any ACP app.

```
ACP app (Zed, ...)  ──ACP──▶  pico acp  (pico-agent.js: whole pico sessions, any model)
                                  │
pico's sessions  ── turn ──▶  ACP engine (engine.js)
                                  │
                         ┌───────┴────────┐
                     ──ACP──▶          ──ACP──▶
              Claude Code adapter   Antigravity adapter
              (claude -p, stream-json) (agy acp, passed through)
```

Models pico calls itself (API keys, ChatGPT for Codex, SuperGrok for Grok) run in pico's own agent loop; the agents with programs of their own (Claude Code, Antigravity) run through the ACP engine. Either way a session is a pico session, so a conversation can move between them.

| File | Role |
| --- | --- |
| `rpc.js` | JSON-RPC 2.0 peers, one message per line |
| `connect.js` | The three ways to meet an agent, one connection shape: `connectAgent` (an adapter in this process), `spawnAgent` (a program speaking ACP), `serveAgent` (pico offering an agent over stdio) |
| `engine.js` | The turn engine for every ACP agent: history sync, tool rows, diffs, questions, subagents, usage |
| `translate.js` | Pure mapping between ACP and pico shapes, and pico's `_meta.pico` extensions |
| `pico-agent.js` | pico as an ACP agent: `pico acp` |

## Adapters

An adapter makes one agent an ACP agent and owns everything particular to it: launching its program, its protocol, its tool names. It labels each tool call with the pico tool it amounts to (`_meta.pico.tool`), so the engine knows nothing of any one agent.

- `../claude-code/adapter.js`: translates Claude Code's stream-json; a session's id is Claude Code's own, so sessions resume and fork across restarts.
- `../antigravity/adapter.js`: passes `agy acp` through, adding pico's rules (no API keys in its environment, no permission prompts, questions marked for the person).

Each provider's `engine.js` is a few lines: the adapter, its label, and what pico adds to its instructions.

## Sign-ins

`../sign-in/` holds every subscription sign-in behind the same calls (status, start, finish, sign out): Claude Code's long-lived token, ChatGPT, SuperGrok and Antigravity. `pico --connect <provider>` uses them, and `pico acp` offers them as ACP auth methods.

## Checking it

`test/acp.test.js` runs the engine against a scripted agent, `test/pico-agent.test.js` the server against a scripted session, and each adapter has its own tests. `node scripts/claude-code-smoke.js` plays real Claude Code turns through the whole layer.
