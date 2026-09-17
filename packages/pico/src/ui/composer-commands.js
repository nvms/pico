export function commandAt(text, cursor = text.length) {
  const match = text.slice(0, cursor).match(/(^|[\s(])\/([A-Za-z0-9_-]*)$/)
  if (!match) return null
  const start = cursor - match[2].length - 1
  const suffix = text.slice(cursor).match(/^[A-Za-z0-9_-]*/)[0]
  return { start, end: cursor + suffix.length, query: match[2] }
}

export function replaceCommand(text, range, body) {
  return {
    text: text.slice(0, range.start) + body + text.slice(range.end),
    cursor: range.start + body.length,
  }
}

export function commandFields(command, body, args = '') {
  const fields = [...(command.arguments ?? [])]
  if (body.includes('$ARGUMENTS') && !args) {
    fields.push({ name: '$args', label: 'Arguments', type: 'text' })
  }
  return fields
}
