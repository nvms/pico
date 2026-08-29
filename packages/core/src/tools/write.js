import { describeParam } from './recorder.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { makeWriteEdit } from '../reversible-edit.js'
import { makeDiff } from './diff.js'

export function createWrite({ cwd, recorder, tracker }) {
  return {
    name: 'write',
    description: 'Write content to a file, creating it and any parent directories if needed. Overwrites existing content.',
    schema: {
      description: describeParam,
      path: { type: 'string', description: 'file path, relative to the working directory or absolute' },
      content: { type: 'string', description: 'the full file content to write' },
    },
    execute: async ({ path, content }) => {
      const full = resolve(cwd, path)
      recorder.extra({ title: path })
      await mkdir(dirname(full), { recursive: true })
      let before = null
      try {
        before = await readFile(full, 'utf-8')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }

      if (before === content) {
        return { ok: true, path, unchanged: true, note: 'file already had exactly this content' }
      }
      await writeFile(full, content, 'utf-8')

      const result = { ok: true, path }
      if (before !== null) {
        const diff = makeDiff(path, before, content)
        recorder.extra({ diff, revert: makeWriteEdit(full, before, content, true) })
        result.additions = diff.additions
        result.deletions = diff.deletions
      } else {
        const diff = makeDiff(path, '', content)
        recorder.extra({ diff, revert: makeWriteEdit(full, '', content, false), created: true })
        result.additions = diff.additions
        result.created = true
      }
      const context = tracker.check(full)
      if (context.length) result.context_from_agents_md = context
      return result
    },
  }
}
