import { execFile } from 'node:child_process'
import fg from 'fast-glob'

const MAX_RESULTS = 200

function ripgrepGlob(pattern, cwd) {
  return new Promise((resolve) => {
    const args = ['--files', '--hidden', '--glob', pattern, '--glob', '!**/node_modules/**', '--glob', '!**/.git/**']
    execFile('rg', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code !== 1) resolve(null)
      else resolve(stdout ? stdout.split('\n').filter(Boolean) : [])
    })
  })
}

export function createGlob({ cwd, recorder }) {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern, relative to the working directory. Respects .gitignore; use bash to look inside ignored paths.',
    schema: {
      pattern: { type: 'string', description: 'glob pattern, e.g. src/**/*.js' },
      maxResults: { type: 'number', description: 'cap on returned paths, default 200', optional: true },
    },
    execute: async ({ pattern, maxResults = MAX_RESULTS }) => {
      recorder.extra({ title: pattern })
      let files = await ripgrepGlob(pattern, cwd)
      if (files === null) {
        files = await fg(pattern, {
          cwd,
          dot: true,
          ignore: ['**/node_modules/**', '**/.git/**'],
        })
      }
      recorder.extra({ fullOutput: files.join('\n') })
      return {
        files: files.slice(0, maxResults),
        totalFound: files.length,
        truncated: files.length > maxResults,
      }
    },
  }
}
