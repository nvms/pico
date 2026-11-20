# Antigravity engine

Runs a pico session's turns through Google's Antigravity agent, on the user's own Google AI plan, instead of through a model API.

## Why

A Google AI Pro or Ultra plan can't be used as an API key, and handing the Google sign-in to another program breaks Antigravity's terms. The supported way to use the plan from another app is to run Google's own, unmodified agent, `agy acp`, and talk to it over the Agent Client Protocol (ACP): the app sends prompts and reads what comes back, and agy signs in, keeps its login and talks to Google itself. This engine does that, so a pico session can use Antigravity's models with agy's own tools at plan cost. pico still owns the session: its log, transcript, peers, questions and host tools work the same as with any other model.

## How

Antigravity is one of the agents pico reaches over ACP (`../acp/README.md`). `agy acp` already speaks ACP, so the adapter passes it through with pico's rules applied, and the ACP engine plays pico's turns through it.

| File | Role |
| --- | --- |
| `adapter.js` | `agy acp` passed through: pico's instructions as agy's system prompt extension, each tool call labelled with the pico tool it amounts to, agy's questions marked for the person, one-question sessions removed from agy's history |
| `process.js` | What agy runs with: its arguments, an environment without API keys, the stand-in browser openers that catch the sign-in page |
| `engine.js` | The ACP engine over the adapter, with what pico tells agy |
| `models.js` | The `agy` command, whether it is signed in (`agy models`), and the model catalog |
| `conversations.js` | Removes the sessions pico opens only to sign in or answer one question from agy's history |
| `../sign-in/antigravity.js` | Signing agy in and out |

**Sign-in.** agy runs the Google sign-in itself, as in a terminal, and keeps its login where it always does, so one sign-in serves `agy` in a terminal and pico alike. The sign-in catches the page agy opens so a host can show it wherever the person is; from another device, the address the page ended on is handed back to agy's listener on this machine. A sign-in counts only once agy opens a session with it. pico never reads agy's login.

**Sessions.** As with any ACP agent: a turn whose history agy has seen sends only the new messages, any other history starts a fresh agy session from a transcript, and a restart resumes the saved session with `session/resume`. agy cannot fork a session, so a forked pico session starts its own from a transcript.

**Models.** The catalog is the model list agy reports when a session opens, kept in pico's home, with `agy models` filling in before any session has. The model and thinking level are session options.

## Rules

- **Plan only.** API keys and Google Cloud settings (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` and the like) are removed from agy's environment, or agy would bill them instead.
- **No permission prompts.** agy runs with `--dangerously-skip-permissions`, as pico does. A question agy means for the person (a permission request whose call id starts `interaction_`) goes through pico's `ask_user`; any other permission is allowed once.
- **Compaction.** agy compacts its own context, so pico doesn't auto-compact these sessions. A manual compact summarizes with the same model in a session of its own.
- **Notes mid-turn** reach agy between tool rounds as a prompt sent while the turn runs, which agy folds into it.

## Not covered

- The plan's usage limits: agy reports them only through its own login, which pico doesn't read.
- Claude and GPT models: Google offers those through ACP only to its own apps.

## Checking it

`test/antigravity.test.js` runs the adapter against a stand-in agy program; no model is called.
