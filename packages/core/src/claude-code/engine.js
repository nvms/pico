// Claude Code as pico's sessions run it: the ACP engine (../acp/engine.js)
// over the Claude Code adapter (adapter.js), in this process.

import { basename } from 'node:path'
import { connectAgent } from '../acp/connect.js'
import { createAcpEngine } from '../acp/engine.js'
import { createClaudeCodeAgent } from './adapter.js'
import { CLAUDE_CODE_PROVIDER } from './models.js'

const HOST_NOTE = `You are running inside pico, an agent runtime, possibly within kagent, a desktop workspace where several agent sessions work side by side. Besides your own tools, the host's tools are available under mcp__pico__: ask_user asks the user questions (use it instead of AskUserQuestion), peer_list and peer_send message other agent sessions, schedule_wakeup schedules a note to your future self, and the host may add more, such as terminals and a browser. Messages that begin with [system notification] or [peer input ...] come from the host or from other agents, not from the user.`

// Claude Code reads CLAUDE.md files itself; any other instructions pico
// would give its own models (AGENTS.md) are passed along. pico's memories
// stand in for Claude Code's own, which is switched off
export function systemPrompt({ contextFiles = [], memoryIndexText = '' } = {}) {
  const files = contextFiles.filter((file) => basename(file.path) !== 'CLAUDE.md' && file.content?.trim())
  const parts = [HOST_NOTE]
  if (memoryIndexText) parts.push(memoryIndexText.replace(/\bthe (remember|recall) tool\b/g, 'the mcp__pico__$1 tool'))
  if (files.length) parts.push(`Project instructions:\n\n${files.map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`).join('\n\n')}`)
  return parts.join('\n\n')
}

// pico's tools Claude Code has its own version of, its subagents included
export const COVERED_TOOLS = new Set([
  'read', 'write', 'edit', 'bash', 'glob', 'grep', 'view', 'shell_output', 'shell_kill', 'tool_result',
  'agent_start', 'agent_list', 'agent_collect', 'agent_cancel',
  'skill',
])

// what Claude Code is told about a pico tool that overlaps one of its own: pico's subagents run on other models, so
// Claude reaches for them only for that, and keeps its own Task tool for Claude's work
const FOR_CLAUDE = {
  agent_start: 'For a worker on a model other than Claude, such as another provider\'s, when the user asked for one or a task needs it. For a subagent on Claude, use your own Task tool instead. ',
}
const offer = (tool) => (FOR_CLAUDE[tool.name] ? { ...tool, description: FOR_CLAUDE[tool.name] + tool.description } : tool)

// `spawn` and `command` reach the adapter, for a test's scripted Claude Code
export function createClaudeCodeEngine({ agent = createClaudeCodeAgent, spawn, command, ...options } = {}) {
  const process = { ...(spawn ? { spawn } : {}), ...(command ? { command } : {}) }
  return createAcpEngine({
    provider: CLAUDE_CODE_PROVIDER,
    label: 'Claude Code',
    connect: ({ cwd, env, ...handlers }) => connectAgent((client, control) => agent(client, control, { cwd, env, ...process }), handlers),
    systemPrompt,
    covered: COVERED_TOOLS,
    offer,
    ...options,
  })
}
