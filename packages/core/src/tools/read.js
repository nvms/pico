import { describeParam } from './recorder.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { extractText } from 'unpdf'

const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

const isPdf = (buffer) => buffer.subarray(0, 5).toString('latin1') === '%PDF-'

// a pdf reads as its extracted text, one page after another, so the same
// offset and limit window applies. poppler's pdftotext keeps the page
// layout (labels beside their values, columns in order) so it is preferred
// when installed; unpdf is the bundled fallback
function pdftotext(full) {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-layout', full, '-'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      const pages = stdout.replace(/\f$/, '').split('\f')
      resolve(pages.map((page) => page.replace(/\s+$/, '').split('\n')))
    })
  })
}

async function unpdfPages(buffer) {
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: false })
  return (Array.isArray(text) ? text : [text]).map((page) => String(page).split('\n'))
}

async function pdfLines(full, buffer) {
  const pages = (await pdftotext(full)) ?? (await unpdfPages(buffer))
  const lines = []
  pages.forEach((page, i) => {
    if (i) lines.push('')
    lines.push(`[page ${i + 1} of ${pages.length}]`)
    lines.push(...page)
  })
  return lines
}

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
      description: describeParam,
      path: { type: 'string', description: 'file path, relative to the working directory or absolute' },
      offset: { type: 'number', description: '1-indexed line to start from', optional: true },
      limit: { type: 'number', description: 'max lines to return', optional: true },
    },
    execute: async ({ path, offset = 1, limit = MAX_LINES }) => {
      const full = resolve(cwd, path)
      recorder.extra({ title: path })
      const buf = await readFile(full)
      const lines = isPdf(buf) ? await pdfLines(full, buf) : null
      if (!lines && isBinary(buf)) throw new Error(`${path} is a binary file`)
      const source = lines ?? buf.toString('utf-8').split('\n')

      const start = Math.max(0, offset - 1)
      const count = Math.min(limit, MAX_LINES)
      const sliced = source.slice(start, start + count)
      const numbered = sliced
        .map((line, i) => `${start + i + 1}\t${line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…' : line}`)
        .join('\n')

      recorder.extra({ fullOutput: sliced.join('\n') })
      const result = { content: numbered, totalLines: source.length }
      if (start + count < source.length) {
        result.note = `showing lines ${start + 1}-${start + sliced.length} of ${source.length}`
      }
      const context = tracker.check(full)
      if (context.length) result.context_from_agents_md = context
      return result
    },
  }
}
