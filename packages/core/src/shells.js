import { spawn } from 'node:child_process'

const MAX_LINES = 2000

function killTree(child, signal) {
  if (!child.pid) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {}
  }
  return child.kill(signal)
}

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

  function track(child, command, { cwd, description, sessionId, sessionFile, hidden = false } = {}) {
    const id = String(nextId++)
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
      hidden,
    }

    const push = (chunk) => {
      const text = shell.partial + chunk.toString()
      const lines = text.split('\n')
      shell.partial = lines.pop() || ''
      shell.lines.push(...lines)
      if (shell.lines.length > MAX_LINES) shell.lines.splice(0, shell.lines.length - MAX_LINES)
      if (!shell.hidden) onChange()
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
      if (!shell.hidden) onChange()
      if (!shell.hidden) onExit(publicView(shell))
    })

    shells.set(id, shell)
    if (!shell.hidden) onChange()
    return { id }
  }

  function start(command, options = {}) {
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    return track(child, command, options)
  }

  function get(id) {
    const shell = shells.get(String(id))
    if (!shell) throw new Error(`no shell with id ${id}; it is gone and cannot be inspected (exited shells disappear when dismissed)`)
    return shell
  }

  return {
    start,
    track,
    reveal(id) {
      const shell = get(id)
      if (shell.hidden) {
        shell.hidden = false
        onChange()
        if (shell.status === 'exited') onExit(publicView(shell))
      }
      return publicView(shell)
    },
    discardHidden(id) {
      const shell = shells.get(String(id))
      if (shell?.hidden) shells.delete(String(id))
    },
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
      killTree(shell.child, 'SIGTERM')
      setTimeout(() => {
        if (shell.status === 'running') killTree(shell.child, 'SIGKILL')
      }, 3000).unref()
      return { id: shell.id, status: 'killing' }
    },
    dismiss(id) {
      const shell = shells.get(String(id))
      if (shell && shell.status === 'exited') {
        shells.delete(String(id))
        if (!shell.hidden) onChange()
      }
    },
    list() {
      return [...shells.values()].filter((shell) => !shell.hidden).map(publicView)
    },
    running() {
      return [...shells.values()].filter((s) => s.status === 'running').length
    },
    killAll() {
      for (const shell of shells.values()) {
        if (shell.status === 'running') {
          shell.killedBy = 'user'
          try {
            killTree(shell.child, 'SIGKILL')
          } catch {}
        }
      }
    },
  }
}
