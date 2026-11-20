// The Antigravity models pico offers, and whether this machine can run
// them. They are reached through Google's own `agy` command and the
// Google sign-in it keeps, never through an API key.

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { picoHome } from '../paths.js'
import { agyEnv } from './process.js'

const exec = promisify(execFile)

export const ANTIGRAVITY_PROVIDER = 'antigravity'

// Gemini's context window; agy does not report one
const CONTEXT = 1000000

// the `agy` executable. A host started from a desktop launcher does not
// have the user's shell PATH, so the installer's own location is looked in too
export function agyCommand(env = process.env) {
  const candidates = [
    ...String(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'agy')),
    join(homedir(), '.local', 'bin', 'agy'),
  ]
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return path } catch {}
  }
  return null
}

// the models agy last said this sign-in may use, kept between runs so a
// host can list them before any session starts
const catalogFile = () => join(picoHome(), 'antigravity-models.json')

export function readCatalog() {
  try { return JSON.parse(readFileSync(catalogFile(), 'utf8')) } catch { return [] }
}

export function writeCatalog(models) {
  if (JSON.stringify(models) === JSON.stringify(readCatalog())) return
  mkdirSync(dirname(catalogFile()), { recursive: true })
  writeFileSync(`${catalogFile()}.new`, JSON.stringify(models))
  renameSync(`${catalogFile()}.new`, catalogFile())
}

// the models `agy models` lists: one per line, its id first
export function parseModelList(stdout) {
  const models = []
  for (const line of String(stdout).split('\n')) {
    const match = line.trim().replace(/^[-*•]\s*/, '').match(/^([a-z][a-z0-9]*(?:[-._][a-z0-9]+)+)\b\s*[-:(]?\s*(.*?)\)?\s*$/i)
    if (match) models.push({ id: match[1], label: match[2] || match[1] })
  }
  return models
}

export function antigravityModels(catalog = readCatalog(), { available = true } = {}) {
  return catalog.map(({ id, label }) => ({
    name: `${ANTIGRAVITY_PROVIDER}/${id}`,
    label: `${label} (Antigravity)`,
    provider: ANTIGRAVITY_PROVIDER,
    context: CONTEXT,
    effort: true,
    vision: true,
    speed: false,
    available,
    keyHint: 'Sign in to Antigravity',
  }))
}

// the id agy takes for a pico model name
export function agyModel(name) {
  return String(name).startsWith(`${ANTIGRAVITY_PROVIDER}/`) ? name.slice(ANTIGRAVITY_PROVIDER.length + 1) : name
}

// whether `agy` is installed and signed in to a Google account. It reads
// only what `agy models` prints: agy's login stays agy's
export async function antigravityStatus({ command = agyCommand() } = {}) {
  if (!command) return { installed: false, connected: false, models: [] }
  try {
    const { stdout } = await exec(command, ['models'], { env: agyEnv(), timeout: 30000, cwd: homedir() })
    const listed = parseModelList(stdout)
    const known = readCatalog()
    // the session's own list names models best; the command's adds any it lacks
    const models = [...known, ...listed.filter((m) => !known.some((k) => k.id === m.id))]
    return { installed: true, connected: true, models }
  } catch (error) {
    return { installed: error.code !== 'ENOENT', connected: false, models: [], ...(/sign in/i.test(`${error.stdout}${error.stderr}`) ? {} : { error: String(error.stderr || error.message).trim().split('\n').at(-1) }) }
  }
}
