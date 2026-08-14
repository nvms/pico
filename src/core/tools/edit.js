import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeReversibleEdit } from '../reversible-edit.js'
import { makeDiff } from './diff.js'

const LOOKALIKES = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-' }

// matching tolerates cosmetic differences the model routinely gets wrong:
// trailing whitespace, smart quotes, dashes. the normalized text is only ever
// used to find the span; offsets map back so the file is spliced at its own
// bytes and nothing outside the replaced span is rewritten
function normalize(text) {
  const chars = []
  const offsets = []
  let last = 0
  const keep = (from, to) => {
    for (let i = from; i < to; i++) {
      chars.push(LOOKALIKES[text[i]] || text[i])
      offsets.push(i)
    }
  }
  for (const match of text.matchAll(/[^\S\n]+$/gm)) {
    keep(last, match.index)
    last = match.index + match[0].length
  }
  keep(last, text.length)
  return { text: chars.join(''), offsets }
}

function locate(content, old, path) {
  const multiple = () => new Error(`string appears multiple times in ${path}, provide more surrounding context to make it unique`)

  const exact = content.indexOf(old)
  if (exact !== -1) {
    if (content.indexOf(old, exact + 1) !== -1) throw multiple()
    return { start: exact, end: exact + old.length }
  }

  const normalizedContent = normalize(content)
  const normalizedOld = normalize(old).text
  if (!normalizedOld) throw new Error(`string not found in ${path}`)
  const at = normalizedContent.text.indexOf(normalizedOld)
  if (at === -1) throw new Error(`string not found in ${path}`)
  if (normalizedContent.text.indexOf(normalizedOld, at + 1) !== -1) throw multiple()

  return {
    start: normalizedContent.offsets[at],
    end: normalizedContent.offsets[at + normalizedOld.length - 1] + 1,
  }
}

export function createEdit({ cwd, recorder, tracker }) {
  return {
    name: 'edit',
    description: 'Replace oldText with newText in a file. oldText must appear exactly once unless replaceAll is set.',
    schema: {
      description: { type: 'string', description: 'briefly explain why this tool call is needed, shown to the human watching' },
      path: { type: 'string', description: 'file path, relative to the working directory or absolute' },
      oldText: { type: 'string', description: 'exact text to replace, must be unique in the file' },
      newText: { type: 'string', description: 'replacement text' },
      replaceAll: { type: 'boolean', description: 'replace every occurrence', optional: true },
    },
    execute: async ({ path, oldText, newText, replaceAll }) => {
      const full = resolve(cwd, path)
      recorder.extra({ title: path })
      const before = await readFile(full, 'utf-8')

      let after
      let splices
      if (replaceAll) {
        if (!oldText) throw new Error('oldText must not be empty when replaceAll is set')
        if (!before.includes(oldText)) throw new Error(`string not found in ${path}`)
        splices = []
        for (let start = before.indexOf(oldText); start !== -1; start = before.indexOf(oldText, start + oldText.length)) {
          splices.push({ start, oldText, newText })
        }
        after = before.split(oldText).join(newText)
      } else {
        const { start, end } = locate(before, oldText, path)
        const actualOldText = before.slice(start, end)
        splices = [{ start, oldText: actualOldText, newText }]
        after = before.slice(0, start) + newText + before.slice(end)
      }

      await writeFile(full, after, 'utf-8')
      const diff = makeDiff(path, before, after)
      recorder.extra({ diff, revert: makeReversibleEdit(full, before, after, splices) })

      const result = { ok: true, path, additions: diff.additions, deletions: diff.deletions }
      const context = tracker.check(full)
      if (context.length) result.context_from_agents_md = context
      return result
    },
  }
}
