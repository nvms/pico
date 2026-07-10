import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { globalAgentsFile } from './paths.js'

function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

export function contextStopDir(cwd) {
  let dir = resolve(cwd)
  const home = homedir()
  while (true) {
    if (existsSync(join(dir, '.git')) || dir === home) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

function ancestorDirs(cwd, stopDir) {
  const dirs = []
  let dir = resolve(cwd)
  while (true) {
    dirs.unshift(dir)
    if (dir === stopDir) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

// AGENTS.md is canonical; CLAUDE.md is honored per directory only when no
// AGENTS.md exists there, so repos documented for other agents still work.
// the fallback never applies to the global file: that is ~/.pico/AGENTS.md
// alone, and personal files like ~/.claude/CLAUDE.md are another tool's
function readDirContext(dir) {
  const agents = join(dir, 'AGENTS.md')
  const agentsContent = readIfExists(agents)
  if (agentsContent) return { path: agents, content: agentsContent }
  const claude = join(dir, 'CLAUDE.md')
  const claudeContent = readIfExists(claude)
  if (claudeContent) return { path: claude, content: claudeContent }
  return null
}

export function loadStartupContext(cwd) {
  const stopDir = contextStopDir(cwd)
  const files = []
  const globalContent = readIfExists(globalAgentsFile())
  if (globalContent) files.push({ path: globalAgentsFile(), content: globalContent })
  for (const dir of ancestorDirs(cwd, stopDir)) {
    const entry = readDirContext(dir)
    if (entry) files.push(entry)
  }
  return { files, stopDir }
}

export function createContextTracker({ stopDir, loaded }) {
  return {
    loaded,
    check(filePath) {
      const target = dirname(resolve(filePath))
      if (!target.startsWith(stopDir)) return []
      const fresh = []
      for (const dir of ancestorDirs(target, stopDir)) {
        if (loaded.has(join(dir, 'AGENTS.md')) || loaded.has(join(dir, 'CLAUDE.md'))) continue
        const entry = readDirContext(dir)
        if (entry) {
          loaded.add(entry.path)
          fresh.push(entry)
        }
      }
      return fresh
    },
  }
}
