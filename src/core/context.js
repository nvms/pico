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

export function loadStartupContext(cwd) {
  const stopDir = contextStopDir(cwd)
  const files = []
  const globalContent = readIfExists(globalAgentsFile())
  if (globalContent) files.push({ path: globalAgentsFile(), content: globalContent })
  for (const dir of ancestorDirs(cwd, stopDir)) {
    const path = join(dir, 'AGENTS.md')
    const content = readIfExists(path)
    if (content) files.push({ path, content })
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
        const path = join(dir, 'AGENTS.md')
        if (loaded.has(path)) continue
        const content = readIfExists(path)
        if (content) {
          loaded.add(path)
          fresh.push({ path, content })
        }
      }
      return fresh
    },
  }
}
