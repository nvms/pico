import { spawn } from 'node:child_process'

const MAX_LINES = 2000

export function createShellManager({ onChange = () => {}, onExit = () => {} } = {}) {
  const shells = new Map()
  let nextId = 1

  function publicView(shell) {
    return {
      id: shell.id,
      command: shell.command,
      description: shell.description,
      sessionId: shell.sessionId,
      sessionFile: shell.sessionFile,
      cwd: shell.cwd,
      status: shell.status,
      exitCode: shell.exitCode,
      startedAt: shell.startedAt,
      endedAt: shell.endedAt,
      killedBy: shell.killedBy,
      lastLine: shell.lines.at(-1) || '',
      lineCount: shell.lines.length,
    }
  }

  function start(command, { cwd, env, description, sessionId, sessionFile } = {}) {
    const id = String(nextId++)
    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const shell = {
      id,
      command,
      description: description || null,
      sessionId: sessionId || null,
      sessionFile: sessionFile || null,
      cwd: cwd || process.cwd(),
      child,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      killedBy: null,
      lines: [],
      partial: '',
    }

    const push = (chunk) => {
      const text = shell.partial + chunk.toString()
      const lines = text.split('\n')
      shell.partial = lines.pop() || ''
      shell.lines.push(...lines)
      if (shell.lines.length > MAX_LINES) shell.lines.splice(0, shell.lines.length - MAX_LINES)
      onChange()
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (err) => {
      push(`[failed to start: ${err.message}]\n`)
    })
    child.on('exit', (code, signal) => {
      if (shell.partial) {
        shell.lines.push(shell.partial)
        shell.partial = ''
      }
      shell.status = 'exited'
      shell.exitCode = code ?? (signal ? 1 : 0)
      shell.endedAt = Date.now()
      onChange()
      onExit(publicView(shell))
    })

    shells.set(id, shell)
    onChange()
    return { id }
  }

  function get(id) {
    const shell = shells.get(String(id))
    if (!shell) throw new Error(`no shell with id ${id}; it is gone and cannot be inspected (exited shells disappear when dismissed)`)
    return shell
  }

  return {
    start,
    output(id, { tail = 100 } = {}) {
      const shell = get(id)
      return {
        id: shell.id,
        command: shell.command,
        status: shell.status,
        exitCode: shell.exitCode,
        output: shell.lines.slice(-tail).join('\n'),
        totalLines: shell.lines.length,
      }
    },
    kill(id, by = 'model') {
      const shell = get(id)
      if (shell.status !== 'running') return { id: shell.id, status: shell.status, exitCode: shell.exitCode }
      shell.killedBy = by
      shell.child.kill('SIGTERM')
      setTimeout(() => {
        if (shell.status === 'running') shell.child.kill('SIGKILL')
      }, 3000).unref()
      return { id: shell.id, status: 'killing' }
    },
    dismiss(id) {
      const shell = shells.get(String(id))
      if (shell && shell.status === 'exited') {
        shells.delete(String(id))
        onChange()
      }
    },
    list() {
      return [...shells.values()].map(publicView)
    },
    running() {
      return [...shells.values()].filter((s) => s.status === 'running').length
    },
    killAll() {
      for (const shell of shells.values()) {
        if (shell.status === 'running') {
          shell.killedBy = 'user'
          try {
            shell.child.kill('SIGKILL')
          } catch {}
        }
      }
    },
  }
}
