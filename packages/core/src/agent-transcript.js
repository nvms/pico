import { defaultTitle } from './tools/recorder.js'

function parseCallArgs(call) {
  try {
    return typeof call.function?.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : call.function?.arguments || {}
  } catch {
    return {}
  }
}

function toolItem(call, startedAt) {
  const args = parseCallArgs(call)
  const name = call.function?.name || 'tool'
  return {
    kind: 'tool',
    callId: call.id,
    name,
    args,
    description: args.description,
    title: defaultTitle(name, args),
    status: 'running',
    startedAt,
  }
}

function settleTool(tools, event) {
  const item = tools.get(event.call?.id)
  if (!item) return
  item.status = event.type === 'tool_error' ? 'error' : 'done'
  item.error = event.error ? String(event.error) : null
  item.fullOutput = event.result === undefined ? null : typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)
}

// a deliberation reads as turns: each turn owns the tool runs its
// participant made before speaking. every recorded event carries the
// speaker's role and round, so a turn opens on its first tool call and
// closes when its text arrives; a turn with tools and no text is running
function deliberationTranscript(agent) {
  const items = [{ kind: 'user', text: agent.prompt }]
  const tools = new Map()
  const turns = new Map()
  const turnFor = (role, round) => {
    const key = `${role}:${round}`
    if (!turns.has(key)) {
      const turn = { kind: 'deliberation-turn', role, round, text: null, tools: [], active: agent.status === 'running' }
      turns.set(key, turn)
      items.push(turn)
    }
    return turns.get(key)
  }
  for (const entry of agent.timeline) {
    if (entry.kind === 'turn') {
      const turn = turnFor(entry.value.role, entry.value.round)
      turn.text = entry.value.text
      turn.active = false
      continue
    }
    const event = entry.value
    if (event.type === 'tool_executing') {
      const item = toolItem(event.call || {}, event.at)
      tools.set(item.callId, item)
      turnFor(event.role, event.round).tools.push(item)
    }
    if (event.type === 'tool_complete' || event.type === 'tool_error') settleTool(tools, event)
  }
  if (agent.result) {
    items.push({ kind: 'deliberation-turn', role: 'synthesis', text: agent.result, tools: [], interrupted: agent.status === 'cancelled' })
  } else if (agent.error) {
    items.push({ kind: 'assistant', text: agent.error, interrupted: true })
  }
  return items
}

export function agentTranscript(agent) {
  if (!agent) return []
  if (agent.role === 'deliberation') return deliberationTranscript(agent)
  const items = [{ kind: 'user', text: agent.prompt }]
  const tools = new Map()
  let response = ''
  for (const event of agent.events) {
    if (event.type === 'content') response += event.content
    if (event.type === 'tool_executing') {
      const item = toolItem(event.call || {}, event.at || agent.updatedAt)
      tools.set(item.callId, item)
      items.push(item)
    }
    if (event.type === 'tool_complete' || event.type === 'tool_error') settleTool(tools, event)
  }
  const text = agent.result || response
  if (text) items.push({ kind: 'assistant', text, interrupted: agent.status === 'cancelled' })
  else if (agent.error) items.push({ kind: 'assistant', text: agent.error, interrupted: true })
  return items
}
