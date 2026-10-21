// Pure translation between Claude Code's stream-json and pico's shapes.
// Nothing here touches a process or the file system, so every rule about
// how a Claude turn becomes pico history, tool rows and usage is testable
// against recorded output.

import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { makeDiff } from '../tools/diff.js'
import { makeWriteEdit } from '../reversible-edit.js'
import { toolResultOutput } from '../tools/recorder.js'
import { commitLabel, elementLabel, fileLabel, selectionLabel } from '../attachments.js'

// pico's own tools run inside Claude Code through the MCP bridge under
// this server name, so Claude sees them as mcp__pico__<name>
export const BRIDGE_SERVER = 'pico'
const BRIDGE_PREFIX = `mcp__${BRIDGE_SERVER}__`

// pico tools Claude Code already has its own version of; offering both
// would only make the model choose between equivalent tools. Memory is
// not among them: Claude Code's own is switched off, so every model in a
// project keeps one store, pico's
export const COVERED_TOOLS = new Set([
  'read', 'write', 'edit', 'bash', 'glob', 'grep', 'view', 'shell_output', 'shell_kill', 'tool_result',
  'agent_plan', 'agent_start', 'agent_list', 'agent_collect', 'agent_cancel', 'deliberate',
  'skill',
])

const SEED_CHARS = 600000
const SEED_TOOL_CHARS = 2000

function shortPath(path, cwd) {
  if (typeof path !== 'string' || !cwd || !isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

// Claude's tool calls under the names and argument shapes pico renders:
// a Bash call shows its command, an Edit its path and diff
export function picoTool(name, input = {}, cwd) {
  if (name.startsWith(BRIDGE_PREFIX)) return { name: name.slice(BRIDGE_PREFIX.length), args: input, bridged: true }
  const path = shortPath(input.file_path ?? input.notebook_path, cwd)
  switch (name) {
    case 'Bash': return { name: 'bash', args: { command: input.command, description: input.description, ...(input.run_in_background ? { background: true } : {}), ...(input.timeout ? { timeout: input.timeout } : {}) } }
    case 'Read': return { name: 'read', args: { path, ...(input.offset != null ? { offset: input.offset } : {}), ...(input.limit != null ? { limit: input.limit } : {}) } }
    case 'Edit': return { name: 'edit', args: { path, oldText: input.old_string, newText: input.new_string, ...(input.replace_all ? { replaceAll: true } : {}) } }
    case 'MultiEdit': return { name: 'edit', args: { path, edits: input.edits } }
    case 'Write': return { name: 'write', args: { path, content: input.content } }
    case 'Glob': return { name: 'glob', args: { pattern: input.pattern, ...(input.path ? { path: shortPath(input.path, cwd) } : {}) } }
    case 'Grep': return { name: 'grep', args: { ...input, ...(input.path ? { path: shortPath(input.path, cwd) } : {}) } }
    case 'Task':
    case 'Agent': return { name: 'Task', args: { description: input.description, prompt: input.prompt, ...(input.subagent_type ? { subagent_type: input.subagent_type } : {}) } }
    default: return { name, args: input }
  }
}

export function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '').filter(Boolean).join('\n')
  return JSON.stringify(content)
}

// what the transcript keeps for one finished Claude tool call: output,
// errors, and for file changes a diff plus the record rewind needs to undo
// them. `after` is the file as it stands once the call returned; a call
// that failed because the turn was interrupted shows as interrupted
export function toolEntry({ id, name, input }, block, extra, { cwd, after = null, interrupted = false } = {}) {
  const { name: picoName, args } = picoTool(name, input, cwd)
  const entry = {
    callId: id,
    name: picoName,
    args,
    title: typeof args.path === 'string' ? args.path : undefined,
    description: args.description,
    status: block.is_error ? (interrupted ? 'interrupted' : 'error') : 'done',
    durationMs: null,
  }
  if (block.is_error && !interrupted) entry.error = toolResultText(block.content).replace(/^<tool_use_error>|<\/tool_use_error>$/g, '')
  if (picoName === 'bash' && extra && typeof extra === 'object') {
    entry.fullOutput = toolResultOutput('bash', extra)
    if (extra.interrupted) entry.status = 'interrupted'
  } else {
    entry.fullOutput = toolResultText(block.content)
  }
  if (!block.is_error && extra && typeof extra === 'object' && typeof extra.filePath === 'string' && (picoName === 'edit' || picoName === 'write')) {
    const before = typeof extra.originalFile === 'string' ? extra.originalFile : null
    const now = after ?? (picoName === 'write' ? extra.content : null)
    if (typeof now === 'string') {
      const shown = shortPath(extra.filePath, cwd)
      entry.diff = makeDiff(shown, before ?? '', now)
      entry.revert = makeWriteEdit(extra.filePath, before ?? '', now, before !== null)
      if (before === null) entry.created = true
    }
  }
  return entry
}

// pico usage from one Claude API response; prompt counts every input
// token the request carried, cached or not, since that is its context size
export function usageOf(usage = {}) {
  const cached = usage.cache_read_input_tokens || 0
  const prompt = (usage.input_tokens || 0) + cached + (usage.cache_creation_input_tokens || 0)
  const completion = usage.output_tokens || 0
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: cached, thoughtTokens: usage.output_tokens_details?.thinking_tokens || 0 }
}

export function addUsage(a, b) {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    thoughtTokens: a.thoughtTokens + b.thoughtTokens,
  }
}

export const emptyUsage = () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, thoughtTokens: 0 })

// ---- pico history to Claude input ----

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

function partText(part) {
  if (part.type === 'text') return part.text
  if (part.type === 'file') return fileLabel(part.path)
  if (part.type === 'selection') return selectionLabel(part)
  if (part.type === 'commit') return commitLabel(part)
  if (part.type === 'element') return elementLabel(part)
  return null
}

// one pico user message as Claude content blocks; `hydrated` is the same
// message after pico's image preparation, which reads images into base64
export function userBlocks(message) {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  const blocks = []
  for (const part of message.content ?? []) {
    if (part.type === 'image' && part.source?.kind === 'base64') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.source.mediaType, data: part.source.data } })
      continue
    }
    const text = partText(part)
    if (text) blocks.push({ type: 'text', text })
  }
  return blocks
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

// a conversation Claude Code never saw (another model's, or one pico
// rewound, steered or compacted) as a transcript it can pick up from
export function seedText(history) {
  return `[system notification] This conversation began before this Claude Code session started, in pico with another model or an earlier context. Its transcript follows so you can continue it. Treat it as history: do not redo work it shows as done, and do not reply to it directly; the newest messages after it are what to respond to.\n\n<transcript>\n${transcriptText(history)}\n</transcript>`
}

// ---- pico tool schemas to JSON Schema, for the MCP bridge ----

function jsonProperty(prop) {
  const out = { type: prop.type }
  if (prop.description) out.description = prop.description
  if (prop.enum) out.enum = prop.enum
  if (prop.items) out.items = jsonProperty(prop.items)
  if (prop.properties) {
    out.properties = Object.fromEntries(Object.entries(prop.properties).map(([key, child]) => [key, jsonProperty(child)]))
    if (prop.required) out.required = prop.required
  }
  return out
}

export function inputSchema(schema = {}) {
  if (schema.type === 'object' && schema.properties) return schema
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(schema)) {
    properties[key] = jsonProperty(prop)
    if (!prop.optional) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}
