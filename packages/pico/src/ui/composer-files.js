export function createComposerFiles() {
  let text = ''
  let references = []

  function update(value, attachments) {
    let start = 0
    while (start < text.length && start < value.length && text[start] === value[start]) start++
    let end = text.length
    let nextEnd = value.length
    while (end > start && nextEnd > start && text[end - 1] === value[nextEnd - 1]) {
      end--
      nextEnd--
    }
    const delta = nextEnd - end
    references = references.flatMap((reference) => {
      if (reference.end <= start) return [reference]
      if (reference.start >= end) return [{ ...reference, start: reference.start + delta, end: reference.end + delta }]
      return []
    })
    text = value
    const matches = [...text.matchAll(/\[File #\d+\]/g)].reverse()
    for (const match of matches) {
      const attachment = attachments.get(match[0])
      if (attachment?.kind !== 'file') continue
      const path = attachment.path
      const offset = path.length - match[0].length
      references = references.map((reference) => reference.start >= match.index + match[0].length
        ? { ...reference, start: reference.start + offset, end: reference.end + offset }
        : reference)
      text = text.slice(0, match.index) + path + text.slice(match.index + match[0].length)
      references.push({ start: match.index, end: match.index + path.length, placeholder: match[0] })
    }
    references.sort((a, b) => a.start - b.start)
    return text
  }

  function content() {
    let value = text
    for (const reference of [...references].reverse()) {
      value = value.slice(0, reference.start) + reference.placeholder + value.slice(reference.end)
    }
    return value
  }

  return { update, content }
}
