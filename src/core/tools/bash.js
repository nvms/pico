import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 30000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024
export const AUTO_BACKGROUND_MS = 150000

function capped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`
}

export function createBash({ cwd, env, recorder, signal, shells, sessionId, sessionFile, autoBackgroundMs = AUTO_BACKGROUND_MS }) {
  return {
    name: 'bash',
    description: 'Run a shell command in the working directory. Each call is a fresh shell: cd does not persist to later calls, so chain directory changes within one command (cd /x && ls) or use absolute paths. Returns stdout, stderr, and exit code. Foreground commands still running after 150 seconds are automatically backgrounded. Run known long-lived commands with background true. Background shells notify you when they exit; inspect them with shell_output and stop them with shell_kill.',
    schema: {
      command: { type: 'string', description: 'the command to run' },
      timeout: { type: 'number', description: 'optional foreground timeout in milliseconds; commands still running after 150 seconds are backgrounded instead', optional: true },
      background: { type: 'boolean', description: 'run in the background and return a shell id immediately', optional: true },
      description: { type: 'string', description: 'for background shells: a few words naming what this is for, shown to the human watching (e.g. "vite dev server", "watching ci")', optional: true },
    },
    execute: ({ command, timeout, background, description }) => {
      if (background && shells) {
        recorder.extra({ title: description || command, background: true })
        const { id } = shells.start(command, { cwd, env, description, sessionId, sessionFile })
        return { shellId: id, status: 'running' }
      }
      return new Promise((resolve) => {
        recorder.extra({ title: command })
        const child = spawn(command, {
          shell: true,
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const { id } = shells
          ? shells.track(child, command, { cwd, description, sessionId, sessionFile, hidden: true })
          : { id: null }
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false

        const collectStdout = (chunk) => { stdout = (stdout + chunk).slice(-MAX_BUFFER_BYTES) }
        const collectStderr = (chunk) => { stderr = (stderr + chunk).slice(-MAX_BUFFER_BYTES) }
        child.stdout.on('data', collectStdout)
        child.stderr.on('data', collectStderr)

        const timeoutTimer = timeout
          ? setTimeout(() => {
              timedOut = true
              child.kill()
            }, timeout)
          : null
        const backgroundTimer = shells
          ? setTimeout(() => {
              if (settled) return
              settled = true
              clearTimeout(timeoutTimer)
              cleanup()
              shells.reveal(id)
              recorder.extra({ title: description || command, background: true })
              resolve({
                shellId: id,
                status: 'running',
                note: `automatically backgrounded after ${autoBackgroundMs}ms; the shell will notify you when it exits`,
              })
            }, autoBackgroundMs)
          : null
        backgroundTimer?.unref?.()
        timeoutTimer?.unref?.()

        function cleanup() {
          if (signal) signal.removeEventListener('abort', abort)
          child.stdout.off('data', collectStdout)
          child.stderr.off('data', collectStderr)
        }
        function abort() {
          child.kill()
        }
        if (signal) {
          if (signal.aborted) child.kill()
          else signal.addEventListener('abort', abort, { once: true })
        }
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(backgroundTimer)
          clearTimeout(timeoutTimer)
          cleanup()
          if (id) shells.discardHidden(id)
          const exitCode = code ?? 1
          recorder.extra({ fullOutput: [stdout, stderr].filter(Boolean).join('\n') })
          resolve({
            stdout: capped(stdout),
            stderr: capped(stderr),
            exitCode,
            ...(timedOut && {
              timedOut: true,
              note: `killed at the ${timeout}ms timeout`,
            }),
          })
        })
      })
    },
  }
}
