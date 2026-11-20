// pico history as an engine (engines.js) hands it to a program that keeps
// its own context. pico's log stays the source of truth and the program's
// context is a cache of it: a turn sends only what the program has not
// seen, and a history that moved underneath it (a rewind, a steer, a
// clear, a compaction, a conversation begun with another model) starts
// the program over from a transcript.

import { createHash } from 'node:crypto'
import { commitLabel, elementLabel, fileLabel, selectionLabel } from './attachments.js'

const SEED_CHARS = 600000
const SEED_TOOL_CHARS = 2000

// the messages a turn adds: everything after the last thing the model
// said. pico appends the user's message, system notes and peer input
// before a turn starts, so these trail the history
export function splitTurn(history) {
  let at = history.length
  while (at > 0 && history[at - 1].role === 'user') at--
  return { prior: history.slice(0, at), input: history.slice(at) }
}

// a hash of what a conversation said, blind to what pico rewrites in place
// later: old tool results get elided or trimmed, so only their ids count
export function fingerprint(history) {
  const hash = createHash('sha256')
  for (const message of history) {
    hash.update(message.role)
    if (message.role === 'tool') hash.update(String(message.tool_call_id))
    else hash.update(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
    for (const call of message.tool_calls ?? []) hash.update(String(call.id))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

// the trailing user messages of `history` the program has not seen, given
// the fingerprint of what it has: null when the history diverged
export function unseen(history, synced) {
  if (!synced) return null
  for (let at = history.length; at >= 0; at--) {
    if (at < history.length && history[at].role !== 'user') break
    if (fingerprint(history.slice(0, at)) === synced) return history.slice(at)
  }
  return null
}

// a non-image part of a pico user message as the text a model reads
export function partText(part) {
  if (part.type === 'text') return part.text
  if (part.type === 'file') return fileLabel(part.path)
  if (part.type === 'selection') return selectionLabel(part)
  if (part.type === 'commit') return commitLabel(part)
  if (part.type === 'element') return elementLabel(part)
  return null
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => partText(part) ?? (part.type === 'image' ? '[image]' : '')).filter(Boolean).join('')
}

// a conversation as plain text, for a model that cannot be handed the
// messages themselves. The most recent part is kept when it is too long
export function transcriptText(history) {
  const lines = []
  for (const message of history) {
    if (message.role === 'user') lines.push(`User:\n${messageText(message)}`)
    else if (message.role === 'assistant') {
      if (message.content) lines.push(`Assistant:\n${typeof message.content === 'string' ? message.content : messageText(message)}`)
      for (const call of message.tool_calls ?? []) lines.push(`Assistant called ${call.function.name}: ${call.function.arguments}`)
    } else if (message.role === 'tool') {
      const text = String(message.content ?? '')
      lines.push(`Tool result:\n${text.length > SEED_TOOL_CHARS ? `${text.slice(0, SEED_TOOL_CHARS)}\n[clipped]` : text}`)
    }
  }
  let body = lines.join('\n\n')
  if (body.length > SEED_CHARS) body = `[earlier conversation omitted]\n\n${body.slice(-SEED_CHARS)}`
  return body
}

// a conversation the program never saw (another model's, or one pico
// rewound, steered or compacted) as a transcript it can pick up from;
// `program` names it, as in "this Claude Code session"
export function seedText(history, program) {
  return `[system notification] This conversation began before this ${program} session started, in pico with another model or an earlier context. Its transcript follows so you can continue it. Treat it as history: do not redo work it shows as done, and do not reply to it directly; the newest messages after it are what to respond to.\n\n<transcript>\n${transcriptText(history)}\n</transcript>`
}
