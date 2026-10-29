import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir, projectSettingsFile } from './paths.js'

// a project's settings: globalInstructions, whether its sessions read the
// global AGENTS.md and any instructions above the project's folder (on
// unless switched off)
const DEFAULTS = { globalInstructions: true }

export function readProjectSettings(root) {
  try {
    const path = projectSettingsFile(root)
    return { ...DEFAULTS, ...(existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

// whether `key` was ever set for the project, rather than left at its default
export function projectSettingSet(root, key) {
  try {
    const path = projectSettingsFile(root)
    return existsSync(path) && key in JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return false
  }
}

export function writeProjectSettings(root, patch) {
  const path = projectSettingsFile(root)
  let current = {}
  try { if (existsSync(path)) current = JSON.parse(readFileSync(path, 'utf-8')) } catch {}
  const next = { ...current, ...patch }
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
  return { ...DEFAULTS, ...next }
}
