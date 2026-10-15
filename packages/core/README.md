# picocode-core

The runtime behind [pico](https://github.com/nvms/pico). It contains everything except rendering: session event logs and their derived state, the agent turn loop, the tool registry, background shells, subagents and deliberation, MCP client support, memories, skills and commands, compaction, rewind, steering, scheduled wake-ups, model catalog and Codex OAuth.

The session driver lives in `controller.js`. `createController({ boot })` owns the conversation state (session log, derived transcript, model, effort, queue, live turn overlay) and exposes methods such as `send`, `interrupt`, `compact`, `resume`, `fork`, `rewind`, `switchModel`, and `sendParallel`, emitting `change`, `flash`, `derived`, `question`, `session`, and `project` events for a frontend to render. The terminal client in `packages/pico` is one consumer.

Modules are imported by path:

```js
import { runTurn } from 'picocode-core/agent.js'
import { deriveState } from 'picocode-core/derive.js'
import { createToolset } from 'picocode-core/tools/index.js'
```

Model access goes through [@prsm/ai](https://github.com/prsmjs/ai), except for models whose provider has a turn engine (`engines.js`): Claude Code models (`claude-code/*`) run through the local `claude` command on the user's Claude subscription; see `src/claude-code/README.md`. The package is plain ESM and requires Node 24 or newer.
