import { continuationMessage } from './compaction.js'
import { applySteering } from './steer.js'

const DROPPING_MODES = ['both', 'chat', 'summary']

// context editing: a large tool result keeps getting re-sent with every
// request long after the model has used it. once the conversation has moved
// on (two user turns past it), the body is replaced with a short note in the
// model's view only; the transcript and the jsonl keep the real thing, and
// the model can re-run the tool if it truly needs the data again
const ELIDE_MIN_CHARS = 4000
const ELIDE_AFTER_USER_TURNS = 2

function elideStaleToolResults(history) {
  const userIndexes = []
  history.forEach((message, i) => {
    if (message.role === 'user') userIndexes.push(i)
  })
  const cutoff = userIndexes.at(-ELIDE_AFTER_USER_TURNS)
  if (cutoff === undefined) return history
  return history.map((message, i) => {
    if (i >= cutoff || message.role !== 'tool') return message
    const content = String(message.content ?? '')
    if (content.length < ELIDE_MIN_CHARS) return message
    return {
      ...message,
      content: `[tool result elided to save context: ${content.length.toLocaleString()} chars. re-run the tool if this is needed again]`,
    }
  })
}

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
  total.thoughtTokens += usage.thoughtTokens || 0
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, thoughtTokens: 0 }
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

function pushHistory(state, message, eventId) {
  state.providerHistory.push(message)
  state.historyEventIds.push(eventId)
}

function foldMessage(state, event) {
  const message = event.data.message
  if (!message) return
  pushHistory(state, message, event.id)
  if (event.data.hideFromTranscript) {
    for (const call of message.tool_calls || []) {
      state.toolItems.set(call.id, { kind: 'tool', callId: call.id, status: 'done', hidden: true })
    }
    return
  }
  const base = {
    messageId: event.id,
    eventId: event.id,
    at: event.at ?? null,
    role: message.role,
    locked: event._sourceIndex < state.latestCompactIndex,
    steered: !!event._steered,
  }

  if (message.role === 'system' || message.role === 'developer') {
    state.transcript.push({ ...base, kind: message.role, text: String(message.content ?? '') })
    return
  }
  if (message.role === 'user') {
    const text = Array.isArray(message.content)
      ? message.content
          .map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[file: ${p.path}]` : `[image: ${String(p.source?.path || '').split('/').pop() || 'attached'}]`))
          .join('')
      : String(message.content)
    state.transcript.push({ ...base, kind: 'user', text, content: message.content, ...(event.data.origin ? { origin: event.data.origin } : {}) })
    return
  }
  if (message.role === 'assistant') {
    if (message.content) {
      state.transcript.push({ ...base, kind: 'assistant', text: message.content, model: state.model })
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
    state.transcript.push({ kind: 'summary', source: 'rewind', text: summaryText })
    pushHistory(state, {
      role: 'assistant',
      content: `[summary of the rewound conversation]\n${summaryText}`,
    }, event.id)
  }
}

export function deriveState(events) {
  const effectiveEvents = applySteering(events)
  const dropped = droppedIds(effectiveEvents)
  const latestCompactIndex = effectiveEvents.reduce((latest, event) => event.type === 'clear' ? -1 : event.type === 'compact' ? events.indexOf(event) : latest, -1)
  const canceledUndoTargets = new Set(
    events.filter((e) => e.type === 'rewind_undo').map((e) => e.data.rewindId),
  )

  const spentUsage = emptyUsage()
  const spentUsageByModel = {}
  for (const event of events) {
    if (event.type !== 'usage') continue
    addUsageInto(spentUsage, event.data.usage)
    addUsageInto((spentUsageByModel[event.data.model] ||= emptyUsage()), event.data.usage)
  }

  const state = {
    transcript: [],
    providerHistory: [],
    historyEventIds: [],
    model: null,
    effort: undefined,
    usage: spentUsage,
    usageByModel: spentUsageByModel,
    usageActive: emptyUsage(),
    usageActiveByModel: {},
    lastPromptTokens: 0,
    lastPromptModel: null,
    loadedContext: new Set(),
    toolItems: new Map(),
    latestCompactIndex,
  }

  for (const event of effectiveEvents) {
    if (event.type === 'usage') {
      if (!dropped.has(event.id)) {
        addUsageInto(state.usageActive, event.data.usage)
        const activeByModel = (state.usageActiveByModel[event.data.model] ||= emptyUsage())
        addUsageInto(activeByModel, event.data.usage)
        // only events that recorded the final request's size can drive the
        // context meter; older cumulative-only events would overstate it
        if (event.data.lastPrompt !== undefined) {
          state.lastPromptTokens = event.data.lastPrompt
          state.lastPromptModel = event.data.model
        }
      }
      continue
    }
    if (dropped.has(event.id)) continue

    switch (event.type) {
      case 'message':
        foldMessage(state, event)
        break
      case 'turn_transcript':
        for (const item of event.data.items || []) {
          const restored = { ...item, eventId: event.id, at: item.at ?? event.at ?? null }
          state.transcript.push(restored)
          if (restored.kind === 'tool' && restored.callId) state.toolItems.set(restored.callId, restored)
        }
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
      case 'compact': {
        const { summary, keepFrom, sessionFile } = event.data
        if (keepFrom !== undefined || sessionFile) {
          const idx = keepFrom ? state.historyEventIds.indexOf(keepFrom) : -1
          const kept = idx >= 0 ? state.providerHistory.slice(idx) : []
          const keptIds = idx >= 0 ? state.historyEventIds.slice(idx) : []
          state.providerHistory = [
            { role: 'user', content: continuationMessage(summary, { sessionFile, recentKept: kept.length > 0 }) },
            ...kept,
          ]
          state.historyEventIds = [null, ...keptIds]
        } else {
          state.providerHistory = [
            { role: 'user', content: `[conversation summary]\n${summary}` },
            { role: 'assistant', content: 'Got it. Continuing from that summary.' },
          ]
          state.historyEventIds = [null, null]
        }
        state.transcript.push({ kind: 'summary', source: 'compact', text: summary })
        state.lastPromptTokens = 0
        break
      }
      case 'clear':
        state.transcript = []
        state.providerHistory = []
        state.historyEventIds = []
        state.toolItems = new Map()
        state.lastPromptTokens = 0
        break
      case 'context_file':
        state.loadedContext.add(event.data.path)
        break
      case 'skill':
        state.transcript.push({ kind: 'skill', name: event.data.name })
        break
      case 'thoughts':
        state.transcript.push({ kind: 'thoughts', text: event.data.text })
        break
      case 'shell_note':
      case 'system_note': {
        pushHistory(state, { role: 'user', content: event.data.text }, event.id)
        const lines = event.data.text.split('\n').filter(Boolean)
        const agentCompletions = lines.filter((line) => /^Agent \d+ \(.+\) finished with status /.test(line))
        if (agentCompletions.length) {
          for (const text of agentCompletions) state.transcript.push({ kind: 'notice', text, agentCompletion: true })
        } else {
          state.transcript.push({ kind: 'notice', text: lines[0] || '' })
        }
        break
      }
    }
  }

  state.providerHistory = elideStaleToolResults(state.providerHistory)
  return state
}

export function userEntries(state) {
  const entries = []
  state.transcript.forEach((item, index) => {
    if (item.kind === 'user') entries.push({ text: item.text, content: item.content, index, eventId: item.eventId })
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
