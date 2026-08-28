export function deliberationsFromEvents(events) {
  const byId = new Map()

  for (const event of events) {
    const data = event.data || {}
    const id = data.deliberationId
    if (!id) continue

    if (event.type === 'deliberation_dismiss') {
      byId.delete(id)
      continue
    }

    if (event.type === 'deliberation_start') {
      byId.set(id, {
        id: `deliberation-${id}`,
        deliberationId: id,
        role: 'deliberation',
        description: data.brief,
        prompt: data.brief,
        model: data.model,
        rounds: data.rounds,
        status: 'running',
        startedAt: event.at,
        updatedAt: event.at,
        events: [],
        turns: [],
        timeline: [],
      })
      continue
    }

    const item = byId.get(id)
    if (!item) continue
    item.updatedAt = event.at

    if (event.type === 'deliberation_event') {
      const recorded = { ...data.event, role: data.role, round: data.round, at: event.at }
      item.events.push(recorded)
      item.timeline.push({ kind: 'event', value: recorded })
    } else if (event.type === 'deliberation_turn') {
      const turn = { role: data.role, round: data.round, text: data.text }
      item.turns.push(turn)
      item.timeline.push({ kind: 'turn', value: turn })
      item.usage = mergeUsage(item.usage, data.usage)
    } else if (event.type === 'deliberation_result') {
      item.result = data.result
      item.error = data.error
      item.usage = mergeUsage(item.usage, data.usage)
      item.status = data.error ? 'failed' : data.interrupted ? 'cancelled' : 'completed'
      item.endedAt = event.at
    }
  }

  return [...byId.values()].sort((a, b) => Number(b.deliberationId) - Number(a.deliberationId))
}

function mergeUsage(current = {}, next = {}) {
  if (!next) return current
  return {
    promptTokens: (current.promptTokens || 0) + (next.promptTokens || 0),
    completionTokens: (current.completionTokens || 0) + (next.completionTokens || 0),
    totalTokens: (current.totalTokens || 0) + (next.totalTokens || 0),
  }
}
