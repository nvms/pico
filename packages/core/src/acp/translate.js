// Pure translation between ACP messages and pico's shapes. Nothing here
// touches a process or the file system.
//
// pico's adapters say more than ACP does about a few things, under
// `_meta.pico` (ACP leaves `_meta` to extensions):
//
// - on session/new: `systemPrompt` (instructions added to the agent's
//   own) and `ephemeral` (one question answered with no tools, nothing
//   kept afterward)
// - on a tool call: `tool` ({ name, args }, the pico tool it amounts to),
//   `bridged` (a call to the client's own MCP server), `subagent`
//   ({ description, prompt, model }, a call that starts one), and
//   `wholeFile` (its diff holds the whole file before and after)
// - on any update: `parentToolCallId`, for a subagent's own traffic
// - on a permission request: `question`, one meant for the person
// - on usage_update: `usage`, the turn's usage so far in pico's shape

import { isAbsolute, relative } from 'node:path'
import { partText } from '../engine-history.js'

export const picoMeta = (message) => message?._meta?.pico ?? {}

export function shortPath(path, cwd) {
  if (typeof path !== 'string' || !cwd || !isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

// the file a call is about
export const callPath = (call = {}) => call.locations?.[0]?.path ?? call.rawInput?.path ?? call.rawInput?.file_path ?? null

// an ACP tool call as the pico tool pico renders it as: the one the
// adapter named, else one read from ACP's own kind and fields
export function toolOf(call = {}, cwd) {
  const meta = picoMeta(call)
  const extra = { ...(meta.bridged ? { bridged: true } : {}), ...(meta.subagent ? { subagent: meta.subagent } : {}) }
  if (meta.tool?.name) return { name: meta.tool.name, args: meta.tool.args ?? {}, ...extra }
  const input = call.rawInput ?? {}
  const path = shortPath(callPath(call), cwd)
  switch (call.kind) {
    case 'execute': return { name: 'bash', args: { command: input.command ?? call.title }, ...extra }
    case 'edit': return { name: 'edit', args: { path }, ...extra }
    case 'delete': return { name: 'delete', args: { path }, ...extra }
    case 'move': return { name: 'move', args: { path, ...(call.locations?.[1]?.path ? { to: shortPath(call.locations[1].path, cwd) } : {}) }, ...extra }
    case 'read': return { name: 'read', args: { path }, ...extra }
    case 'search': return { name: 'grep', args: { pattern: input.pattern ?? input.query ?? call.title, ...(path ? { path } : {}) }, ...extra }
    case 'fetch': return { name: 'web_fetch', args: { url: input.url ?? call.title }, ...extra }
    default: return { name: call.title || call.kind || 'tool', args: input, ...extra }
  }
}

// a change to a file, whose before and after rewind can restore
export const changesFile = (name) => ['edit', 'write', 'delete', 'move'].includes(name)

function blockText(block) {
  if (!block) return ''
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'resource') return block.resource?.text ?? ''
  if (block.type === 'resource_link') return block.uri ?? ''
  if (block.type === 'image') return '[image]'
  return ''
}

// what a finished call returned, as text: what it said, else what it changed
export function resultText(call = {}) {
  const items = call.content ?? []
  const said = items.filter((item) => item.type === 'content').map((item) => blockText(item.content)).filter(Boolean).join('\n')
  if (said) return said
  const changed = items.filter((item) => item.type === 'diff').map((item) => `edited ${item.path}`).join('\n')
  if (changed) return changed
  const output = call.rawOutput
  if (output == null) return ''
  if (typeof output === 'string') return output
  for (const key of ['output', 'result', 'error']) if (typeof output[key] === 'string') return output[key]
  return JSON.stringify(output)
}

export const diffsOf = (call = {}) => (call.content ?? []).filter((item) => item.type === 'diff')

// pico usage from ACP's: input counted without what was cached, output
// without the thinking
export function usageOf(usage = {}) {
  const cached = usage.cachedReadTokens || 0
  const prompt = (usage.inputTokens || 0) + cached + (usage.cachedWriteTokens || 0)
  const thought = usage.thoughtTokens || 0
  const completion = (usage.outputTokens || 0) + thought
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: cached, thoughtTokens: thought }
}

// pico usage as ACP's
export function acpUsage(usage = {}) {
  const cached = usage.cachedTokens || 0
  const thought = usage.thoughtTokens || 0
  return { inputTokens: Math.max(0, (usage.promptTokens || 0) - cached), cachedReadTokens: cached, outputTokens: Math.max(0, (usage.completionTokens || 0) - thought), thoughtTokens: thought, totalTokens: usage.totalTokens || 0 }
}

// one pico user message as ACP content blocks; `message` comes after
// pico's image preparation, which reads images into base64
export function userBlocks(message) {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  const blocks = []
  for (const part of message.content ?? []) {
    if (part.type === 'image' && part.source?.kind === 'base64') {
      blocks.push({ type: 'image', data: part.source.data, mimeType: part.source.mediaType })
      continue
    }
    const text = partText(part)
    if (text) blocks.push({ type: 'text', text })
  }
  return blocks
}

// ACP content blocks as a pico user message's content
export function picoContent(blocks = []) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && block.data) parts.push({ type: 'image', source: { kind: 'base64', mediaType: block.mimeType, data: block.data } })
    else if (block.type === 'resource' && block.resource?.text != null) parts.push({ type: 'text', text: `<file path="${block.resource.uri}">\n${block.resource.text}\n</file>` })
    else if (block.type === 'resource_link') parts.push({ type: 'text', text: `[file: ${block.uri}]` })
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
}

// a permission an agent asks for, answered as pico runs: allowed, once
export const allowOption = (options = []) => options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? null

// an agent's question to the person, as pico's ask_user takes it
export function questionOf({ toolCall = {}, options = [] }) {
  const input = toolCall.rawInput ?? {}
  const question = input.question ?? input.Question ?? input.prompt ?? input.message ?? toolCall.title ?? 'The agent has a question.'
  return { id: 'answer', question: String(question), type: 'single', options: options.map((o) => ({ label: o.name })), allowOther: false }
}

// the option the person chose, from ask_user's answer
export function chosenOption(answer, options = []) {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? '')
  return [...options].sort((a, b) => b.name.length - a.name.length).find((o) => text.includes(o.name)) ?? null
}

// the select options a session offers: a model, a thinking level
const choices = (option) => (option?.options ?? []).flatMap((choice) => (Array.isArray(choice.options) ? choice.options : [choice]))
export const modelOption = (configOptions = []) => configOptions.find((o) => o.id === 'model' || o.category === 'model') ?? null
export const thoughtOption = (configOptions = []) => configOptions.find((o) => o.category === 'thought_level') ?? null

export function modelsOffered(configOptions) {
  return choices(modelOption(configOptions)).filter((c) => c.value).map((c) => ({ id: String(c.value), label: c.name || String(c.value) }))
}

// the thinking level to ask for, given pico's effort: the level of that
// name, or the nearest the model has
const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export function thoughtValue(configOptions, effort) {
  const option = thoughtOption(configOptions)
  if (!option || !effort) return null
  const values = choices(option).map((c) => String(c.value))
  // the agent's own choice, where it offers one
  if (effort === 'auto') return values.includes('auto') ? 'auto' : null
  if (values.includes(effort)) return effort
  const want = LADDER.indexOf(effort)
  const ranked = values.filter((v) => LADDER.includes(v)).sort((a, b) => Math.abs(LADDER.indexOf(a) - want) - Math.abs(LADDER.indexOf(b) - want) || LADDER.indexOf(b) - LADDER.indexOf(a))
  return ranked[0] ?? null
}
