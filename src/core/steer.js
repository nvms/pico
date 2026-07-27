export const STEER_ROLES = ['user', 'assistant']

function validRole(role) {
  return STEER_ROLES.includes(role)
}

function insertionIndex(timeline, anchor) {
  if (!anchor) {
    const first = timeline.findIndex((event) => event.type === 'message')
    return first < 0 ? timeline.length : first
  }
  let index = timeline.indexOf(anchor) + 1
  let followsToolSequence = !!anchor.data.message.tool_calls?.length
  while (index < timeline.length) {
    const event = timeline[index]
    if (event.type !== 'message') {
      index++
      continue
    }
    const message = event.data.message
    if (followsToolSequence && message.role === 'tool') {
      index++
      continue
    }
    if (followsToolSequence && message.role === 'assistant' && !message.content && message.tool_calls?.length) {
      index++
      continue
    }
    break
  }
  return index
}

function insertedEvent(transaction, change, index) {
  return {
    id: change.id,
    at: transaction.at,
    type: 'message',
    data: { message: change.message },
    _steered: true,
    _sourceIndex: index,
  }
}

export function applySteering(events) {
  const timeline = []
  const messages = new Map()
  const active = new Set()
  const insertionTails = new Map()
  let compactIndex = -1

  const rebuildActive = () => {
    active.clear()
    for (const event of timeline) {
      if (event.type === 'clear') active.clear()
      else if (event.type === 'message') active.add(event.id)
    }
  }

  events.forEach((event, sourceIndex) => {
    if (event.type !== 'steer') {
      const normalized = event.type === 'message' ? { ...event, _sourceIndex: sourceIndex } : event
      timeline.push(normalized)
      if (event.type === 'message') {
        messages.set(event.id, normalized)
        active.add(event.id)
      } else if (event.type === 'clear') {
        active.clear()
        compactIndex = -1
      } else if (event.type === 'compact') {
        compactIndex = sourceIndex
      }
      return
    }

    for (const change of event.data.changes || []) {
      if (change.op === 'replace') {
        const target = messages.get(change.target)
        if (!target || !active.has(change.target) || target._sourceIndex < compactIndex) continue
        if (!validRole(change.message?.role)) continue
        target.data = {
          ...target.data,
          message: { ...target.data.message, role: change.message.role, content: change.message.content },
        }
        target._steered = true
        continue
      }
      if (change.op === 'insert') {
        if (!change.id || !STEER_ROLES.includes(change.message?.role)) continue
        const anchor = change.after == null ? null : messages.get(change.after)
        if (anchor && (!active.has(change.after) || anchor._sourceIndex < compactIndex)) continue
        if (!anchor && change.after != null) continue
        const inserted = insertedEvent(event, change, sourceIndex)
        const tailId = insertionTails.get(change.after) || change.after
        const tail = tailId == null ? null : messages.get(tailId)
        const at = insertionIndex(timeline, tail)
        timeline.splice(at, 0, inserted)
        messages.set(inserted.id, inserted)
        active.add(inserted.id)
        insertionTails.set(change.after, inserted.id)
      }
    }
    rebuildActive()
  })

  return timeline
}

export function steerableTranscript(transcript) {
  return transcript.filter((item) => item.messageId && STEER_ROLES.includes(item.role || item.kind))
}
