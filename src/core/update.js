import { exec } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const REGISTRY_URL = 'https://registry.npmjs.org/picocode/latest'

function stateFile() {
  return join(picoHome(), 'update-check.json')
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf-8'))
  } catch {
    return {}
  }
}

async function writeState(patch) {
  const state = { ...(await readState()), ...patch }
  ensureDir(picoHome())
  await writeFile(stateFile(), JSON.stringify(state) + '\n')
}

export async function fetchLatestVersion({ timeoutMs = 5000 } = {}) {
  if (process.env.PICO_FAKE_LATEST) return process.env.PICO_FAKE_LATEST
  const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.json()
  return body.version || null
}

export function newerVersion(current, latest) {
  if (!latest || latest === current) return null
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0)
  const cur = parse(current)
  const next = parse(latest)
  for (let i = 0; i < 3; i++) {
    if ((next[i] ?? 0) > (cur[i] ?? 0)) return latest
    if ((next[i] ?? 0) < (cur[i] ?? 0)) return null
  }
  return null
}

// at most one registry hit per interval, one notification per version, all
// failures silent: an update check must never cost the session anything.
// PICO_FAKE_LATEST bypasses cadence and memory so the toast can be demoed
export async function checkForUpdate(currentVersion) {
  const fake = !!process.env.PICO_FAKE_LATEST
  const state = await readState()
  if (!fake && state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) return null

  let latest = null
  try {
    latest = await fetchLatestVersion()
  } catch {
    return null
  } finally {
    if (!fake) await writeState({ lastCheck: Date.now() }).catch(() => {})
  }

  const newer = newerVersion(currentVersion, latest)
  if (!newer) return null
  if (!fake && state.notifiedVersion === newer) return null
  return {
    version: newer,
    markNotified: () => (fake ? Promise.resolve() : writeState({ notifiedVersion: newer }).catch(() => {})),
  }
}

export function isDevInstall(entryUrl) {
  return !String(entryUrl).includes('/node_modules/')
}

export function runUpdate() {
  return new Promise((resolve) => {
    exec('npm install -g picocode@latest', { timeout: 180000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(0, 400) })
    })
  })
}
