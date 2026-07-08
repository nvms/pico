import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeDiff } from './diff.js'

const normalize = (s) =>
  s
    .replace(/\s+$/gm, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')

function locate(content, old, path) {
  let index = content.indexOf(old)
  if (index !== -1) {
    if (content.indexOf(old, index + 1) !== -1) {
      throw new Error(`string appears multiple times in ${path}, provide more surrounding context to make it unique`)
    }
    return { index, length: old.length, content }
  }

  const normedContent = normalize(content)
  const normedOld = normalize(old)
  index = normedContent.indexOf(normedOld)
  if (index === -1) throw new Error(`string not found in ${path}`)
  if (normedContent.indexOf(normedOld, index + 1) !== -1) {
    throw new Error(`string appears multiple times in ${path}, provide more surrounding context to make it unique`)
  }
  return { index, length: normedOld.length, content: normedContent }
}

export function createEdit({ cwd, recorder, tracker }) {
  return {
    name: 'edit',
    description: 'Replace oldText with newText in a file. oldText must appear exactly once unless replaceAll is set.',
    schema: {
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
      if (replaceAll) {
        if (!before.includes(oldText)) throw new Error(`string not found in ${path}`)
        after = before.split(oldText).join(newText)
      } else {
        const { index, length, content } = locate(before, oldText, path)
        after = content.slice(0, index) + newText + content.slice(index + length)
      }

      await writeFile(full, after, 'utf-8')
      const diff = makeDiff(path, before, after)
      recorder.extra({ diff, revert: { path: full, before, after } })

      const result = { ok: true, path, additions: diff.additions, deletions: diff.deletions }
      const context = tracker.check(full)
      if (context.length) result.context_from_agents_md = context
      return result
    },
  }
}
