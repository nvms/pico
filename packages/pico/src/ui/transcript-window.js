export function compactTranscriptRuns(items, active = false) {
  const result = []
  for (let i = 0; i < items.length;) {
    if (items[i].kind === 'tool' || items[i].kind === 'thoughts') {
      let end = i + 1
      while (end < items.length && (items[end].kind === 'tool' || items[end].kind === 'thoughts')) end++
      const run = items.slice(i, end)
      const tools = run.filter((item) => item.kind === 'tool')
      result.push({ kind: 'tool-group', callId: tools.at(-1)?.callId, items: run, tools, active: active && end === items.length })
      i = end
      continue
    }
    if (items[i].kind === 'notice' && items[i].agentCompletion) {
      let end = i + 1
      while (end < items.length && items[end].kind === 'notice' && items[end].agentCompletion) end++
      const run = items.slice(i, end)
      result.push(run.length === 1 ? run[0] : { kind: 'agent-notice-group', notices: run })
      i = end
      continue
    }
    result.push(items[i++])
  }
  return result
}

export function transcriptWindow(items, size) {
  const start = Math.max(0, items.length - size)
  const hidden = items.slice(0, start)
  return {
    items: items.slice(start),
    hiddenItems: hidden.length,
    hiddenCount: hidden.reduce((total, item) => total + sourceItemCount(item), 0),
  }
}

function sourceItemCount(item) {
  if (item.kind === 'tool-group') return item.items.length
  if (item.kind === 'agent-notice-group') return item.notices.length
  if (item.kind === 'steer-tools') return item.count
  return 1
}
