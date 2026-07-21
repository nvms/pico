function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function visibleLines(text, limit) {
  return String(text).split('\n').slice(0, limit).join('\n')
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
  if (item.kind === 'agent-notice-group') {
    return verbose ? item.notices.map((notice, index) => ({ field: 'text', text: notice.text, lineOffset: 3 + index })) : []
  }
  if (item.kind === 'thoughts') {
    return verbose && item.text ? [{ field: 'text', text: visibleLines(item.text, 300), lineOffset: 3 }] : []
  }
  if (item.kind === 'summary') {
    const fields = [{ field: 'text', text: visibleLines(item.text, verbose ? 500 : 0), lineOffset: 3 }]
    return verbose ? fields : []
  }
  if (item.kind === 'tool') {
    const fields = [{ field: 'title', text: item.title || item.name || '', lineOffset: 1 }]
    if (verbose && item.fullOutput) fields.push({ field: 'fullOutput', text: visibleLines(item.fullOutput, 200), lineOffset: 4 })
    return fields
  }
  return item.text ? [{ field: 'text', text: item.text, lineOffset: 1 }] : []
}

export function conversationMatches(items, query, verbose = false) {
  const matches = []
  items.forEach((item, itemIndex) => {
    searchableFields(item, verbose).forEach(({ field, text, lineOffset }, fieldIndex) => {
      matchOffsets(text, query).forEach((offset, occurrenceIndex) => {
        const line = lineOffset + String(text).slice(0, offset).split('\n').length - 1
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
    if (item.kind === 'summary' && !verbose) return item
    if (item.kind === 'tool') {
      const decorated = { ...item }
      const title = item.title || item.name || ''
      const titleCount = matchOffsets(title, query).length
      decorated.title = highlightMatches(title, query, currentIndex, startIndex)
      startIndex += titleCount
      if (verbose && item.fullOutput) {
        const visibleOutput = visibleLines(item.fullOutput, 200)
        const outputCount = matchOffsets(visibleOutput, query).length
        decorated.fullOutput = highlightMatches(item.fullOutput, query, currentIndex, startIndex)
        startIndex += outputCount
      }
      return decorated
    }
    if (!item.text) return item
    const visibleText = item.kind === 'thoughts' ? visibleLines(item.text, 300)
      : item.kind === 'summary' ? visibleLines(item.text, 500)
        : item.text
    const count = matchOffsets(visibleText, query).length
    const decorated = { ...item, text: highlightMatches(item.text, query, currentIndex, startIndex) }
    startIndex += count
    return decorated
  }
  return items.map(decorate)
}
