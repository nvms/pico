const DROPPING_MODES = ['both', 'chat', 'summary']

function activeRewinds(events) {
  const canceled = new Set()
  for (const e of events) {
    if (e.type === 'rewind_undo') canceled.add(e.data.rewindId)
  }
  return events.filter((e) => e.type === 'rewind' && !canceled.has(e.id))
}

function droppedIds(events) {
  const dropped = new Set()
  const index = new Map(events.map((e, i) => [e.id, i]))
  for (const rewind of activeRewinds(events)) {
    if (!DROPPING_MODES.includes(rewind.data.mode)) continue
    const from = index.get(rewind.data.target)
    const to = index.get(rewind.id)
    if (from === undefined || to === undefined) continue
    for (let i = from; i < to; i++) dropped.add(events[i].id)
  }
  return dropped
}

function addUsageInto(total, usage) {
  total.promptTokens += usage.promptTokens || 0
  total.completionTokens += usage.completionTokens || 0
  total.totalTokens += usage.totalTokens || 0
  total.cachedTokens += usage.cachedTokens || 0
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function foldMessage(state, event) {
  const message = event.data.message
  if (!message || message.role === 'system') return
  state.providerHistory.push(message)

  if (message.role === 'user') {
    state.transcript.push({ kind: 'user', text: String(message.content), eventId: event.id })
    return
  }
  if (message.role === 'assistant') {
    if (message.content) {
      state.transcript.push({ kind: 'assistant', text: message.content, model: state.model })
    }
    for (const call of message.tool_calls || []) {
      const item = {
        kind: 'tool',
        callId: call.id,
        name: call.function.name,
        args: parseArgs(call.function.arguments),
        title: call.function.name,
        status: 'done',
        eventId: event.id,
      }
      state.transcript.push(item)
      state.toolItems.set(call.id, item)
    }
    return
  }
  if (message.role === 'tool') {
    const item = state.toolItems.get(message.tool_call_id)
    if (item) item.resultText = String(message.content)
  }
}

function foldRewind(state, event) {
  const { mode, summaryText, reverted = [] } = event.data
  for (const callId of reverted) {
    const item = state.toolItems.get(callId)
    if (item) item.status = 'reverted'
  }
  if (mode === 'summary' && summaryText) {
    state.transcript.push({ kind: 'summary', text: summaryText })
    state.providerHistory.push({
      role: 'assistant',
      content: `[summary of the rewound conversation]\n${summaryText}`,
    })
  }
}

export function deriveState(events) {
  const dropped = droppedIds(events)
  const canceledUndoTargets = new Set(
    events.filter((e) => e.type === 'rewind_undo').map((e) => e.data.rewindId),
  )

  const state = {
    transcript: [],
    providerHistory: [],
    model: null,
    effort: undefined,
    usage: emptyUsage(),
    usageByModel: {},
    loadedContext: new Set(),
    toolItems: new Map(),
  }

  for (const event of events) {
    if (event.type === 'usage') {
      addUsageInto(state.usage, event.data.usage)
      const byModel = (state.usageByModel[event.data.model] ||= emptyUsage())
      addUsageInto(byModel, event.data.usage)
      continue
    }
    if (dropped.has(event.id)) continue

    switch (event.type) {
      case 'message':
        foldMessage(state, event)
        break
      case 'tool_meta': {
        const item = state.toolItems.get(event.data.callId)
        if (item) Object.assign(item, event.data, { kind: 'tool', callId: item.callId })
        break
      }
      case 'interrupt': {
        const last = state.transcript.at(-1)
        if (last?.kind === 'assistant') last.interrupted = true
        if (last?.kind === 'tool' && last.status === 'running') last.status = 'interrupted'
        break
      }
      case 'model_switch':
        state.model = event.data.to
        break
      case 'effort':
        state.effort = event.data.to
        break
      case 'title':
        state.title = event.data.text
        break
      case 'color':
        state.color = event.data.value
        break
      case 'rewind':
        if (!canceledUndoTargets.has(event.id)) foldRewind(state, event)
        break
      case 'compact':
        state.providerHistory = [
          { role: 'user', content: `[conversation summary]\n${event.data.summary}` },
          { role: 'assistant', content: 'Got it. Continuing from that summary.' },
        ]
        state.transcript.push({ kind: 'summary', text: event.data.summary })
        break
      case 'clear':
        state.transcript = []
        state.providerHistory = []
        state.toolItems = new Map()
        break
      case 'context_file':
        state.loadedContext.add(event.data.path)
        break
      case 'skill':
        state.transcript.push({ kind: 'skill', name: event.data.name })
        break
    }
  }

  return state
}

export function userEntries(state) {
  const entries = []
  state.transcript.forEach((item, index) => {
    if (item.kind === 'user') entries.push({ text: item.text, index, eventId: item.eventId })
  })
  return entries
}

export function rewindStats(state, index) {
  const tail = state.transcript.slice(index)
  return {
    msgs: tail.length,
    edits: tail.filter((m) => m.kind === 'tool' && m.revert && m.status !== 'reverted'),
  }
}
