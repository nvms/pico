const filler = /(?<![^\s,;:!?])(?:uh|um)(?=$|[\s,;:.!?])([ \t]*[,;:.!?]*)[ \t]*/giu

export function cleanDictation(text) {
  return text.split('\n').map(cleanLine).join('\n').trim()
}

function cleanLine(line) {
  let result = ''
  let offset = 0
  let capitalize = false
  for (const match of line.matchAll(filler)) {
    let before = line.slice(offset, match.index)
    if (capitalize) before = upperFirst(before)
    result += before
    const after = line.slice(match.index + match[0].length)
    const terminal = match[1].match(/[.!?]+/)?.[0] ?? ''
    result = result.trimEnd()
    const sentenceStart = !result || /[.!?]$/.test(result)
    result = result.replace(/,$/, '')
    if (!after) result = result.replace(/[;:]$/, '')
    if (terminal && !sentenceStart) result += terminal
    capitalize = sentenceStart || Boolean(terminal)
    if (result && after) result += ' '
    offset = match.index + match[0].length
  }
  const tail = line.slice(offset)
  return result + (capitalize ? upperFirst(tail) : tail)
}

function upperFirst(text) {
  return text.replace(/^(\s*)(\p{Ll})(?!\p{Lu})/u, (_, space, letter) => space + letter.toUpperCase())
}

