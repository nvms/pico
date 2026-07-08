import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

function isBinary(buffer) {
  const len = Math.min(buffer.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export function createRead({ cwd, recorder, tracker }) {
  return {
    name: 'read',
    description: 'Read a file. Returns line-numbered content. Use offset/limit for large files.',
    schema: {
      path: { type: 'string', description: 'file path, relative to the working directory or absolute' },
      offset: { type: 'number', description: '1-indexed line to start from', optional: true },
      limit: { type: 'number', description: 'max lines to return', optional: true },
    },
    execute: async ({ path, offset = 1, limit = MAX_LINES }) => {
      const full = resolve(cwd, path)
      recorder.extra({ title: path })
      const buf = await readFile(full)
      if (isBinary(buf)) throw new Error(`${path} is a binary file`)
      const lines = buf.toString('utf-8').split('\n')

      const start = Math.max(0, offset - 1)
      const count = Math.min(limit, MAX_LINES)
      const sliced = lines.slice(start, start + count)
      const numbered = sliced
        .map((line, i) => `${start + i + 1}\t${line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…' : line}`)
        .join('\n')

      recorder.extra({ fullOutput: sliced.join('\n') })
      const result = { content: numbered, totalLines: lines.length }
      if (start + count < lines.length) {
        result.note = `showing lines ${start + 1}-${start + sliced.length} of ${lines.length}`
      }
      const context = tracker.check(full)
      if (context.length) result.context_from_agents_md = context
      return result
    },
  }
}
