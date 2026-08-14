import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 30000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024
const OUTPUT_PREVIEW_LINES = 8
const MAX_PREVIEW_LINE_CHARS = 4000
export const AUTO_BACKGROUND_MS = 150000

function capped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`
}

function createOutputPreview() {
  let lines = []
  let current = ''
  let completed = 0

  function add(chunk) {
    const parts = String(chunk).split('\n')
    current = (current + parts[0]).slice(0, MAX_PREVIEW_LINE_CHARS)
    for (let i = 1; i < parts.length; i++) {
      lines.push(current)
      if (lines.length > OUTPUT_PREVIEW_LINES) lines.shift()
      completed++
      current = parts[i].slice(0, MAX_PREVIEW_LINE_CHARS)
    }
  }

  function snapshot() {
    const visible = current ? [...lines, current].slice(-OUTPUT_PREVIEW_LINES) : lines
    if (!visible.length) return null
    const count = completed + (current ? 1 : 0)
    return {
      fullOutput: visible.join('\n'),
      outputLineStart: count - visible.length + 1,
      outputLineCount: count,
    }
  }

  return { add, snapshot }
}

function killTree(child, signal = 'SIGTERM') {
  if (!child.pid) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {}
  }
  return child.kill(signal)
}

export function createBash({ cwd, env, recorder, signal, shells, sessionId, sessionFile, autoBackgroundMs = AUTO_BACKGROUND_MS }) {
  return {
    name: 'bash',
    description: 'Run a shell command in the working directory. Each call is a fresh shell: cd does not persist to later calls, so chain directory changes within one command (cd /x && ls) or use absolute paths. Returns stdout, stderr, and exit code. Foreground commands still running after 150 seconds are automatically backgrounded. Run known long-lived commands with background true. Background shells notify you when they exit. If no independent work remains, end your turn and wait for that notification instead of polling. Use shell_output only when intermediate output is needed to diagnose a problem or make a decision before exit. Stop shells with shell_kill.',
    schema: {
      command: { type: 'string', description: 'the command to run' },
      timeout: { type: 'number', description: 'optional foreground timeout in milliseconds; commands still running after 150 seconds are backgrounded instead', optional: true },
      background: { type: 'boolean', description: 'run in the background and return a shell id immediately', optional: true },
      description: { type: 'string', description: 'a few words explaining the purpose of this command, shown to the human watching' },
    },
    execute: ({ command, timeout, background, description }) => {
      if (background && shells) {
        recorder.extra({ title: command, titleLang: 'bash', description, background: true })
        const { id } = shells.start(command, { cwd, env, description, sessionId, sessionFile })
        return {
          shellId: id,
          status: 'running',
          note: 'the shell will notify you when it exits; if no independent work remains, end your turn and wait instead of polling with shell_output, wake-ups, sleeps, or another shell',
        }
      }
      return new Promise((resolve) => {
        recorder.extra({ title: command, titleLang: 'bash' })
        const child = spawn(command, {
          shell: true,
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })
        const { id } = shells
          ? shells.track(child, command, { cwd, description, sessionId, sessionFile, hidden: true })
          : { id: null }
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        let killTimer = null
        const preview = createOutputPreview()

        const updateOutput = () => {
          const snapshot = preview.snapshot()
          if (snapshot) recorder.extra(snapshot)
        }
        const collectStdout = (chunk) => {
          stdout = (stdout + chunk).slice(-MAX_BUFFER_BYTES)
          preview.add(chunk)
          updateOutput()
        }
        const collectStderr = (chunk) => {
          stderr = (stderr + chunk).slice(-MAX_BUFFER_BYTES)
          preview.add(chunk)
          updateOutput()
        }
        child.stdout.on('data', collectStdout)
        child.stderr.on('data', collectStderr)

        const timeoutTimer = timeout
          ? setTimeout(() => {
              timedOut = true
              terminate()
            }, timeout)
          : null
        const backgroundTimer = shells
          ? setTimeout(() => {
              if (settled) return
              settled = true
              clearTimeout(timeoutTimer)
              cleanup()
              shells.reveal(id)
              recorder.extra({ title: command, titleLang: 'bash', description, background: true })
              resolve({
                shellId: id,
                status: 'running',
                note: `automatically backgrounded after ${autoBackgroundMs}ms; the shell will notify you when it exits; if no independent work remains, end your turn and wait instead of polling`,
              })
            }, autoBackgroundMs)
          : null
        backgroundTimer?.unref?.()
        timeoutTimer?.unref?.()

        function cleanup() {
          if (signal) signal.removeEventListener('abort', abort)
          child.stdout.off('data', collectStdout)
          child.stderr.off('data', collectStderr)
          clearTimeout(killTimer)
        }
        function terminate() {
          if (!killTree(child, 'SIGTERM')) return
          clearTimeout(killTimer)
          killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 3000)
          killTimer.unref?.()
        }
        function abort() {
          terminate()
        }
        if (signal) {
          if (signal.aborted) terminate()
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
          updateOutput()
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
