export function streamTranscript(items, text) {
  const boundary = items.findIndex(item => item.streamPending)
  const index = boundary < 0 ? items.length : boundary
  return [
    ...items.slice(0, index),
    ...(text ? [{ kind: 'assistant', text }] : []),
    ...items.slice(index).map(({ streamPending, ...item }) => item),
  ]
}
