import { structuredPatch } from 'diff'

export function makeDiff(path, oldText, newText, contextLines = 3) {
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context: contextLines })
  let additions = 0
  let deletions = 0
  const hunks = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    newStart: h.newStart,
    lines: h.lines.map((line) => {
      const type = line[0] === '-' ? 'remove' : line[0] === '+' ? 'add' : 'context'
      if (type === 'add') additions++
      if (type === 'remove') deletions++
      return { type, text: line.slice(1) }
    }),
  }))
  return { path, hunks, additions, deletions }
}
