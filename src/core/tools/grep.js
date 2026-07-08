import { execFile } from 'node:child_process'
import { relative, resolve } from 'node:path'

const MAX_RESULTS = 200

function runRipgrep(args, cwd) {
  return new Promise((done) => {
    execFile('rg', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      done(err && !stdout ? '' : stdout || '')
    })
  })
}

export function createGrep({ cwd, recorder }) {
  return {
    name: 'grep',
    description: 'Search file contents with a regex using ripgrep. mode "content" returns matching lines, "files" returns matching file paths, "count" returns per-file match counts.',
    schema: {
      pattern: { type: 'string', description: 'regex pattern' },
      path: { type: 'string', description: 'file or directory to search, defaults to the working directory', optional: true },
      mode: { type: 'string', enum: ['content', 'files', 'count'], optional: true },
      glob: { type: 'string', description: 'filter files by glob, e.g. *.js', optional: true },
      ignoreCase: { type: 'boolean', optional: true },
      context: { type: 'number', description: 'lines of context around matches', optional: true },
      multiline: { type: 'boolean', description: 'allow patterns to span lines', optional: true },
      limit: { type: 'number', description: 'max results, default 200', optional: true },
    },
    execute: async ({ pattern, path, mode = 'content', glob, ignoreCase, context, multiline, limit = MAX_RESULTS }) => {
      recorder.extra({ title: pattern })
      const args = ['--no-heading', '--color=never', '--max-columns', '500']

      if (mode === 'files') args.push('--files-with-matches')
      else if (mode === 'count') args.push('--count')
      else args.push('--line-number')

      if (ignoreCase) args.push('--ignore-case')
      if (multiline) args.push('--multiline', '--multiline-dotall')
      if (glob) args.push('--glob', glob)
      if (mode === 'content' && context) args.push('-C', String(context))

      args.push(pattern.startsWith('-') ? '-e' : '--', pattern)
      args.push(path ? resolve(cwd, path) : cwd)

      const stdout = await runRipgrep(args, cwd)
      const lines = stdout.split('\n').filter(Boolean)
      recorder.extra({ fullOutput: lines.join('\n') })

      const relativize = (line) => {
        if (mode === 'files') return relative(cwd, line)
        const m = line.match(/^(\/[^:]+):(.*)$/)
        return m ? `${relative(cwd, m[1])}:${m[2]}` : line
      }
      const results = lines.map(relativize).slice(0, limit)
      return { results, mode, totalMatches: lines.length, truncated: lines.length > limit }
    },
  }
}
