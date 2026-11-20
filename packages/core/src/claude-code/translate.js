// Pure translation between Claude Code's stream-json and ACP, as the
// adapter speaks it. Nothing here touches a process or the file system, so
// every rule about how Claude's messages read in ACP is testable against
// recorded output.

import { isAbsolute, relative } from 'node:path'

function shortPath(path, cwd) {
  if (typeof path !== 'string' || !cwd || !isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

// the file a Claude tool works on
export const toolPath = (input = {}) => input.file_path ?? input.notebook_path ?? null

// ACP's kind for a Claude tool, which ACP apps use to choose how to show it
export function acpKind(name) {
  if (name === 'Bash') return 'execute'
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Read', 'NotebookRead'].includes(name)) return 'read'
  if (['Grep', 'Glob'].includes(name)) return 'search'
  if (['WebFetch', 'WebSearch'].includes(name)) return 'fetch'
  return 'other'
}

// the pico tool a Claude tool call amounts to: a Bash call shows its
// command, an Edit its path and change. A call to one of the client's own
// MCP servers (`servers`), which Claude names mcp__<server>__<tool>, is
// that tool
export function picoTool(name, input = {}, cwd, servers = []) {
  for (const server of servers) {
    const prefix = `mcp__${server}__`
    if (name.startsWith(prefix)) return { name: name.slice(prefix.length), args: input, bridged: true }
  }
  const path = shortPath(toolPath(input), cwd)
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

// Claude's tools that start a subagent
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

// a call's title, as an ACP app shows it
export function callTitle(name, input = {}, cwd) {
  if (name === 'Bash') return input.description || input.command || 'Bash'
  if (SUBAGENT_TOOLS.has(name)) return input.description || 'Subagent'
  const path = toolPath(input)
  return path ? `${name} ${shortPath(path, cwd)}` : name
}

export function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '').filter(Boolean).join('\n')
  return JSON.stringify(content)
}

// usage from one Claude API response, as ACP counts it
export function usageOf(usage = {}) {
  return {
    inputTokens: usage.input_tokens || 0,
    cachedReadTokens: usage.cache_read_input_tokens || 0,
    cachedWriteTokens: usage.cache_creation_input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    thoughtTokens: 0,
  }
}

export function addUsage(a, b) {
  const sum = Object.fromEntries(Object.keys(a).map((key) => [key, (a[key] || 0) + (b[key] || 0)]))
  return { ...sum, totalTokens: sum.inputTokens + sum.cachedReadTokens + sum.cachedWriteTokens + sum.outputTokens }
}

export const emptyUsage = () => ({ inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 })

// the prompt a request carried, cached or not: its context size
export const promptSize = (usage) => usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens

// ACP content blocks as Claude's
export function claudeContent(blocks = []) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && block.data) out.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
    else if (block.type === 'resource' && block.resource?.text != null) out.push({ type: 'text', text: `<file path="${block.resource.uri}">\n${block.resource.text}\n</file>` })
    else if (block.type === 'resource_link') out.push({ type: 'text', text: `[file: ${block.uri}]` })
  }
  return out
}

// the MCP servers an ACP client offers, as Claude Code's --mcp-config takes them
export function mcpConfig(servers = []) {
  const pairs = (list = []) => Object.fromEntries(list.map(({ name, value }) => [name, value]))
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, server.type === 'http' || server.type === 'sse'
      ? { type: server.type, url: server.url, headers: pairs(server.headers) }
      : { type: 'stdio', command: server.command, args: server.args ?? [], env: pairs(server.env) }])),
  }
}
