import { Markdown, ScrollBox, useInput } from '@trendr/core'
import { accent, FAINT } from './theme.js'

const HELP_TEXT = (commands) => `pico is a coding agent in your terminal. It reads, edits, and searches files, runs commands, and streams its work into this transcript.

## Commands

Type \`/\` in the composer to filter these as you type.

${commands.map((c) => `- \`/${c.name}\` - ${c.desc}`).join('\n')}

Two kinds of user-defined entries join this menu:

- **commands** (\`~/.pico/commands/<name>.md\` or \`.pico/commands/<name>.md\`): prompt templates you invoke as \`/<name> [args]\`. \`$ARGUMENTS\` in the body is replaced with whatever follows the command; without a placeholder, args are appended. The model never sees these until you run one.
- **skills** (\`~/.pico/skills/<name>/SKILL.md\` or \`.pico/skills/<name>/SKILL.md\`): capabilities with a name and description. You can invoke them like commands, and the agent can also discover and load them itself via the skill tool.
- **tools** (\`~/.pico/tools/<name>.js\` or \`.pico/tools/<name>.js\`): ES modules default-exporting \`{ name, description, schema, execute }\` (or a factory receiving \`{ cwd, root }\`). They join the agent's toolset and are rescanned every turn, so edits apply on the next message. Ask the agent to build one for you: the built-in \`/new-tool\` skill teaches it the format.

In the MCP panel: space or enter toggles a server, \`t\` lists its tools, \`r\` reconnects, \`a\` adds, \`d\` removes. Unfiltered lists (effort, rewind options, MCP) also move with \`j\`/\`k\` and jump with \`g\`/\`G\`.

## Composer

- \`enter\` sends, \`shift+enter\` inserts a newline
- \`@\` opens a fuzzy file picker; enter inserts the selected path
- drag an image file into the terminal to attach it: it appears inline as \`[Image #N]\`, exactly where your cursor is, so images can sit between sentences; backspace after one removes the whole attachment
- \`tab\` completes: \`/summ<tab>\` finishes the command name and cycles through matches on repeat; after an argument space it completes values (\`/model fla<tab>\`, \`/color <tab>\`, \`/effort <tab>\`) and file paths for skills and commands. Keep typing to narrow, tab or enter inserts
- \`up\` and \`down\` on an empty composer recall messages you already sent
- \`ctrl+r\` fuzzy-searches your prompt history with a preview; enter puts the match back in the composer
- \`ctrl+s\` opens the session picker (same as \`/resume\`); \`ctrl+t\` opens the model picker
- \`ctrl+p\` switches projects: pick one and pico jumps to its most recent session, changing the working directory, tools, context, and MCP servers to match; \`/new\` starts a fresh session in the current project
- \`ctrl+b\` cycles thinking effort (default, low, medium, high, max) on models that support it; \`/effort\` opens the full picker
- inside a search panel, \`ctrl+s\` cycles the scope instead: this session, this project, or everywhere
- \`/rewind\` restores the conversation to an earlier message; a rewind can be undone with \`ctrl+z\`
- messages sent while the agent is responding queue up above the composer and are delivered as one message when the turn finishes; \`up\` pulls them back for editing
- \`esc\` interrupts a streaming response, or clears the composer when idle

## Moving around

- \`tab\` switches focus between the transcript and the composer
- with the transcript focused, \`up\`/\`down\`/\`j\`/\`k\` scroll and \`g\`/\`G\` jump to the ends
- long sessions render only the newest 50 messages; scrolling to the very top loads older ones in batches (the top line shows how many are hidden)
- \`ctrl+o\` expands and collapses tool output in the transcript
- the mouse wheel scrolls; click-drag selects text and copies it on release
- \`ctrl+c\` twice exits

## Shells

The agent can run long-lived processes (dev servers, watchers) with \`bash background: true\`, then read their output and stop them itself. \`/shells\` lists them: enter opens a live output view, \`k\` kills (press twice), \`d\` dismisses a dead one. A \`⚙ N\` in the footer shows how many are running. When a shell exits on its own, the agent is notified and responds; shells die with pico, and quitting warns you if any are still up.

## Subscriptions

\`/connect\` lists subscription providers you can sign in with instead of API keys. OpenAI (ChatGPT / Codex plan) signs in through your browser via OAuth; tokens are stored in \`~/.pico/auth.json\` and refreshed automatically, so you sign in once. Once connected, codex models appear in \`/model\`, billed to your plan. \`d\` in the panel disconnects.

## Web search

With a [dredge](https://github.com/jonathanpyers/dredge) endpoint configured, the agent gets two extra tools: \`web_search\` (ranked results, Google-style operators) and \`web_fetch\` (any url as clean paginated markdown, including pdf and docx). Configure it as \`"dredge": { "url": "...", "apiKey": "..." }\` in \`~/.pico/config.json\`, or with \`DREDGE_URL\` and \`DREDGE_API_KEY\`. Without a configured endpoint the tools are not offered to the model at all.

## Memory

The agent saves durable facts with the remember tool: one file per memory under \`~/.pico/memory\` (global) or the project's directory in \`~/.pico/projects\`. Only a one-line index is in its context; it loads a specific memory with the recall tool when relevant. \`/memory\` lists everything it knows. Ask it to remember, forget, or clean up its memories in plain language.

## Wake-ups

The agent can schedule one-time wake-ups for itself with the schedule_wakeup tool: after the delay it receives its own note as a system notification and acts on it. Recurring loops are just the agent rescheduling at the end of each wake-up. \`/wakeups\` lists pending ones with live countdowns; enter or \`k\` cancels. A \`⏰ N\` in the footer shows how many are pending. Wake-ups live in memory and are lost when pico exits.

## Appearance

pico picks a light or dark palette at startup by asking the terminal for its background color (OSC 11), so it matches whatever theme your terminal uses. \`/theme\` opens a picker that previews each theme as you move and persists your choice in \`~/.pico/config.json\`; \`/theme light\`, \`/theme dark\`, or \`/theme auto\` applies one directly. \`/color\` tints a single session's accent and is independent of the palette.

## Context

pico reads AGENTS.md files automatically: a global one from ~/.pico, then every ancestor of your working directory up to the git root. Deeper files win. AGENTS.md files in subdirectories load lazily the first time a tool touches that subtree.

Sessions are stored under ~/.pico as jsonl event logs; \`/resume\` folds one back into exactly this view.

\`/context\` breaks down what the next request will contain - system prompt, tool schemas, project instructions, memory index, compaction summary, and conversation - with an estimated size for each piece next to the provider-measured total.

The footer's \`ctx %\` shows how full the model's context is. At 85% pico auto-compacts: the older conversation is summarized in a structured form, the most recent turns are kept verbatim, and the model is told where the full session file lives so it can read exact details back on demand. Nothing visible changes in the transcript, and rewind still works across it. \`/compact\` runs it manually and takes optional focus instructions (\`/compact focus on the API changes\`). Set \`"autoCompact": false\` in \`~/.pico/config.json\` to disable the automatic trigger.

---

*esc takes you back to the conversation*`

export function Help({ commands, onClose }) {
  useInput((event) => {
    if (event.key === 'escape') {
      onClose()
      event.stopPropagation()
    }
  })

  return (
    <box style={{ flexDirection: 'column', height: '100%', paddingX: 2, paddingY: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text style={{ color: accent(), bold: true }}>pico · help</text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ color: FAINT }}>↑↓ scroll · esc back</text>
      </box>
      <text> </text>
      <ScrollBox style={{ flexGrow: 1 }} focused scrollbar>
        <Markdown text={HELP_TEXT(commands)} codeBg={null} />
      </ScrollBox>
    </box>
  )
}
