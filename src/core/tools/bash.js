import { exec } from 'node:child_process'

const MAX_OUTPUT_CHARS = 30000

function capped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`
}

export function createBash({ cwd, recorder, signal, shells }) {
  return {
    name: 'bash',
    description: 'Run a shell command in the working directory. Returns stdout, stderr, and exit code. Set background true for long-running processes like dev servers: it returns a shell id immediately; check on it with shell_output and stop it with shell_kill.',
    schema: {
      command: { type: 'string', description: 'the command to run' },
      timeout: { type: 'number', description: 'timeout in milliseconds, default 120000', optional: true },
      background: { type: 'boolean', description: 'run in the background and return a shell id immediately', optional: true },
    },
    execute: ({ command, timeout, background }) => {
      if (background && shells) {
        recorder.extra({ title: command, background: true })
        const { id } = shells.start(command, { cwd })
        return {
          shellId: id,
          status: 'running',
          note: 'started in the background; use shell_output to read its output and shell_kill to stop it',
        }
      }
      return new Promise((resolve) => {
        recorder.extra({ title: command })
        const child = exec(
          command,
          {
            cwd,
            timeout: timeout || 120000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          },
          (err, stdout, stderr) => {
            const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0
            recorder.extra({ fullOutput: [stdout, stderr].filter(Boolean).join('\n') })
            resolve({ stdout: capped(stdout || ''), stderr: capped(stderr || ''), exitCode })
          },
        )
        if (signal) {
          if (signal.aborted) {
            child.kill()
            return
          }
          signal.addEventListener('abort', () => child.kill(), { once: true })
        }
      })
    },
  }
}
