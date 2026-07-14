import { spawn } from 'node:child_process'
import { readFileSync, statSync, watch } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const DEBOUNCE_MS = 500
const POLL_MS = 15000
const GIT_TIMEOUT_MS = 5000

function findGitDir(startDir) {
  let dir = startDir
  while (true) {
    const candidate = join(dir, '.git')
    try {
      const info = statSync(candidate)
      if (info.isDirectory()) return candidate
      const text = readFileSync(candidate, 'utf-8')
      const match = text.match(/^gitdir:\s*(.+?)\s*$/m)
      if (match) return isAbsolute(match[1]) ? match[1] : resolve(dir, match[1])
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readBranch(gitDir) {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim()
    const ref = head.match(/^ref: refs\/heads\/(.+)$/)
    return ref ? ref[1] : head.slice(0, 7)
  } catch {
    return null
  }
}

function parseShortstat(output) {
  const added = output.match(/(\d+) insertion/)
  const removed = output.match(/(\d+) deletion/)
  return {
    added: added ? Number(added[1]) : 0,
    removed: removed ? Number(removed[1]) : 0,
  }
}

export function createGitService({ onChange = () => {} } = {}) {
  let enabled = false
  let root = null
  let gitDir = null
  let epoch = 0
  let watcher = null
  let poll = null
  let debounce = null
  let child = null
  let rerun = false
  let current = null

  function teardown() {
    epoch += 1
    watcher?.close()
    watcher = null
    if (poll) clearInterval(poll)
    poll = null
    if (debounce) clearTimeout(debounce)
    debounce = null
    child?.kill('SIGKILL')
    child = null
    rerun = false
    if (current) {
      current = null
      onChange()
    }
  }

  function setup() {
    teardown()
    if (!enabled || !root) return
    gitDir = findGitDir(root)
    if (!gitDir) return
    const started = epoch
    try {
      watcher = watch(gitDir, () => {
        if (epoch === started) refresh()
      })
      watcher.on('error', () => {})
    } catch {
      watcher = null
    }
    poll = setInterval(run, POLL_MS)
    poll.unref?.()
    run()
  }

  function refresh() {
    if (!enabled || !gitDir || debounce) return
    debounce = setTimeout(() => {
      debounce = null
      run()
    }, DEBOUNCE_MS)
    debounce.unref?.()
  }

  function run() {
    if (!enabled || !gitDir || !root) return
    if (child) {
      rerun = true
      return
    }
    const started = epoch
    const branch = readBranch(gitDir)
    const proc = spawn('git', ['--no-optional-locks', 'diff', 'HEAD', '--shortstat'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child = proc
    let output = ''
    proc.stdout.on('data', (chunk) => {
      output += chunk
    })
    const timeout = setTimeout(() => proc.kill('SIGKILL'), GIT_TIMEOUT_MS)
    timeout.unref?.()
    let finished = false
    const done = (code) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (child === proc) child = null
      if (epoch !== started) return
      const stats = code === 0 ? parseShortstat(output) : { added: 0, removed: 0 }
      const next = branch ? { branch, ...stats } : null
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next
        onChange()
      }
      if (rerun) {
        rerun = false
        refresh()
      }
    }
    proc.on('close', done)
    proc.on('error', () => done(-1))
  }

  return {
    status: () => current,
    refresh,
    retarget(nextRoot) {
      root = nextRoot
      setup()
    },
    setEnabled(value) {
      enabled = value === true
      setup()
    },
    dispose: teardown,
  }
}
