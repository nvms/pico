function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchOffsets(text, query) {
  if (!query) return []
  const matches = []
  const pattern = new RegExp(escapeRegex(query), 'gi')
  let match
  while ((match = pattern.exec(String(text))) !== null) matches.push(match.index)
  return matches
}

export function highlightMatches(text, query, currentIndex = -1, startIndex = 0) {
  if (!query) return text
  const pattern = new RegExp(escapeRegex(query), 'gi')
  const parts = String(text).split(/(\x1b\[[0-9;]*m)/)
  let index = startIndex
  return parts.map((part) => {
    if (part.startsWith('\x1b[')) return part
    return part.replace(pattern, (match) => {
      const current = index++ === currentIndex
      return current
        ? `\x1b[7;33m${match}\x1b[27;39m`
        : `\x1b[7m${match}\x1b[27m`
    })
  }).join('')
}

function searchableFields(item, verbose) {
  if (item.kind === 'tool-group') return item.tools.flatMap((tool) => searchableFields(tool, verbose))
  if (item.kind === 'agent-notice-group') return verbose ? item.notices.map((notice) => ['text', notice.text]) : []
  if (item.kind === 'thoughts') return verbose && item.text ? [['text', item.text]] : []
  if (item.kind === 'tool') {
    const fields = [['title', item.title || item.name || '']]
    if (verbose && item.fullOutput) fields.push(['fullOutput', item.fullOutput])
    return fields
  }
  return item.text ? [['text', item.text]] : []
}

export function conversationMatches(items, query, verbose = false) {
  const matches = []
  items.forEach((item, itemIndex) => {
    searchableFields(item, verbose).forEach(([field, text], fieldIndex) => {
      matchOffsets(text, query).forEach((offset, occurrenceIndex) => {
        const line = String(text).slice(0, offset).split('\n').length - 1
        matches.push({ itemIndex, field, fieldIndex, offset, line, occurrenceIndex })
      })
    })
  })
  return matches
}

export function highlightConversation(items, query, currentIndex, verbose = false) {
  let startIndex = 0
  function decorate(item) {
    if (item.kind === 'tool-group') return { ...item, tools: item.tools.map(decorate) }
    if (item.kind === 'agent-notice-group') {
      if (!verbose) return item
      return { ...item, notices: item.notices.map(decorate) }
    }
    if (item.kind === 'thoughts' && !verbose) return item
    if (item.kind === 'tool') {
      const decorated = { ...item }
      const title = item.title || item.name || ''
      const titleCount = matchOffsets(title, query).length
      decorated.title = highlightMatches(title, query, currentIndex, startIndex)
      startIndex += titleCount
      if (verbose && item.fullOutput) {
        const outputCount = matchOffsets(item.fullOutput, query).length
        decorated.fullOutput = highlightMatches(item.fullOutput, query, currentIndex, startIndex)
        startIndex += outputCount
      }
      return decorated
    }
    if (!item.text) return item
    const count = matchOffsets(item.text, query).length
    const decorated = { ...item, text: highlightMatches(item.text, query, currentIndex, startIndex) }
    startIndex += count
    return decorated
  }
  return items.map(decorate)
}
