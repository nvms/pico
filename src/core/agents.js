import { getText } from '@prsm/ai'

export function resultText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const text = getText(messages[i].content || '').trim()
      if (text) return text
    }
  }
  return ''
}

function restoredAgent(data, at) {
  return {
    id: String(data.agentId),
    description: data.description || data.prompt?.slice(0, 80) || `agent ${data.agentId}`,
    prompt: data.prompt || '',
    model: data.model || null,
    role: data.role || 'worker',
    parentId: data.parentId || null,
    sessionId: data.sessionId || null,
    sessionFile: data.sessionFile || null,
    tools: data.tools || [],
    status: 'cancelled',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    endedAt: at,
    events: [],
    result: '',
    error: null,
    usage: null,
    options: data,
  }
}

export function reduceAgentEvents(events = []) {
  const agents = new Map()
  for (const record of events) {
    const data = record.data || {}
    const id = String(data.agentId || '')
    if (!id) continue
    if (record.type === 'agent_start') {
      agents.set(id, restoredAgent(data, record.at))
      continue
    }
    if (record.type === 'agent_dismiss') {
      agents.delete(id)
      continue
    }
    const agent = agents.get(id)
    if (!agent) continue
    if (record.type === 'agent_event') {
      agent.events.push(data.event)
      agent.updatedAt = record.at
      if (data.event?.type === 'usage') agent.usage = data.event.usage
    } else if (record.type === 'agent_result') {
      agent.result = data.result || resultText(data.messages)
      agent.usage = data.usage || agent.usage
      agent.error = data.error || null
      agent.status = data.error ? 'failed' : data.interrupted ? 'cancelled' : 'completed'
      agent.updatedAt = record.at
      agent.endedAt = record.at
    }
  }
  const restored = [...agents.values()]
  for (const agent of restored) {
    agent.done = Promise.resolve(agent)
    agent.resolve = () => {}
  }
  return restored
}

export function createAgentManager({ run, concurrency = 8, onChange = () => {}, onCreate = () => {}, onEvent = () => {}, onFinish = () => {}, defaults = () => ({}) } = {}) {
  const agents = new Map()
  const queue = []
  let nextId = 1
  let active = 0
  let generation = 0

  const changed = () => onChange()

  function pump() {
    while (active < concurrency && queue.length) {
      const agent = queue.shift()
      if (agent.status !== 'queued') continue
      agent.status = 'running'
      agent.startedAt = Date.now()
      agent.generation = generation
      active++
      changed()
      Promise.resolve().then(() => run(agent, agent.controller.signal, (event) => {
        if (agent.generation !== generation) return
        agent.events.push(event)
        if (event.type === 'usage') agent.usage = event.usage
        agent.updatedAt = Date.now()
        onEvent(agent, event)
        changed()
      })).then((result) => {
        if (agent.generation !== generation) return
        agent.result = typeof result === 'string' ? result : resultText(result?.messages)
        agent.usage = result?.usage || agent.usage
        agent.error = result?.error || null
        agent.status = agent.error ? 'failed' : result?.interrupted ? 'cancelled' : 'completed'
      }).catch((error) => {
        if (agent.generation !== generation) return
        agent.error = String(error?.message || error)
        agent.status = agent.controller.signal.aborted ? 'cancelled' : 'failed'
      }).finally(() => {
        if (agent.generation !== generation) return agent.resolve(agent)
        agent.endedAt = Date.now()
        active--
        onFinish(agent)
        changed()
        agent.resolve(agent)
        pump()
      })
    }
  }

  function start(options) {
    options = { ...defaults(), ...options }
    const id = String(nextId++)
    let resolve
    const done = new Promise((r) => { resolve = r })
    if (!options.prompt?.trim()) throw new Error('agent prompt is required')
    const agent = {
      id,
      description: options.description || options.prompt.slice(0, 80),
      prompt: options.prompt,
      model: options.model,
      role: options.role || 'worker',
      parentId: options.parentId || null,
      sessionId: options.sessionId || null,
      sessionFile: options.sessionFile || null,
      tools: options.tools || [],
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      events: [],
      result: '',
      error: null,
      usage: null,
      controller: new AbortController(),
      resolve,
      done,
      options,
    }
    agents.set(id, agent)
    onCreate(agent)
    queue.push(agent)
    changed()
    pump()
    return agent
  }

  function restore(events) {
    generation++
    for (const agent of agents.values()) {
      if (agent.status === 'queued') agent.resolve(agent)
      else if (agent.status === 'running') agent.controller.abort()
    }
    agents.clear()
    queue.length = 0
    active = 0
    let maxId = 0
    for (const agent of reduceAgentEvents(events)) {
      agents.set(agent.id, agent)
      maxId = Math.max(maxId, Number(agent.id) || 0)
    }
    nextId = maxId + 1
    changed()
  }

  return {
    start,
    restore,
    clear: () => restore([]),
    get: (id) => agents.get(String(id)) || null,
    list: () => [...agents.values()].sort((a, b) => Number(b.id) - Number(a.id)),
    collect: async (ids) => {
      const selected = await Promise.all(ids.map((id) => agents.get(String(id))?.done).filter(Boolean))
      const at = Date.now()
      for (const agent of selected) agent.collectedAt = at
      changed()
      return selected
    },
    dismiss(id) {
      const agent = agents.get(String(id))
      if (!agent || ['queued', 'running'].includes(agent.status)) return false
      agents.delete(String(id))
      changed()
      return true
    },
    cancel(id) {
      const agent = agents.get(String(id))
      if (!agent || ['completed', 'failed', 'cancelled'].includes(agent.status)) return false
      if (agent.status === 'queued') {
        agent.status = 'cancelled'
        agent.endedAt = Date.now()
        onFinish(agent)
        agent.resolve(agent)
        changed()
      } else agent.controller.abort()
      return true
    },
    cancelAll() {
      for (const agent of agents.values()) this.cancel(agent.id)
    },
  }
}
