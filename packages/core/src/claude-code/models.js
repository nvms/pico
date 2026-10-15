// The Claude Code models pico offers, and whether this machine can run
// them. They are reached through the local `claude` command and its own
// claude.ai sign-in, never through an API key.

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { claudeEnv } from './cli.js'

const exec = promisify(execFile)

export const CLAUDE_CODE_PROVIDER = 'claude-code'

// the CLI's model aliases always name the newest model of each family;
// every one of them has a 1M token context window
const FAMILIES = [
  { alias: 'fable', label: 'Fable' },
  { alias: 'opus', label: 'Opus' },
  { alias: 'sonnet', label: 'Sonnet' },
  { alias: 'haiku', label: 'Haiku' },
]

export function claudeCodeModels({ available = true } = {}) {
  return FAMILIES.map(({ alias, label }) => ({
    name: `${CLAUDE_CODE_PROVIDER}/${alias}`,
    label: `${label} (Claude Code)`,
    provider: CLAUDE_CODE_PROVIDER,
    context: 1000000,
    effort: true,
    vision: true,
    speed: false,
    available,
    keyHint: 'claude auth login',
  }))
}

// the alias the CLI takes for a pico model name
export function cliModel(name) {
  return String(name).startsWith(`${CLAUDE_CODE_PROVIDER}/`) ? name.slice(CLAUDE_CODE_PROVIDER.length + 1) : name
}

// the `claude` executable. A host started from a desktop launcher does not
// have the user's shell PATH, so Claude Code's own install locations are
// looked in too
export function claudeCommand(env = process.env) {
  const candidates = [
    ...String(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'claude')),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
  ]
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return path } catch {}
  }
  return 'claude'
}

// whether `claude` is installed and signed in to claude.ai. A machine with
// only an API key configured does not count: that is what pico's own
// Anthropic models are for
export async function claudeCodeStatus({ command = claudeCommand() } = {}) {
  try {
    const { stdout } = await exec(command, ['auth', 'status', '--json'], { env: claudeEnv(), timeout: 15000 })
    const status = JSON.parse(stdout)
    const subscribed = status.loggedIn === true && status.authMethod === 'claude.ai'
    return { installed: true, connected: subscribed, email: subscribed ? status.email ?? null : null, plan: subscribed ? status.subscriptionType ?? null : null }
  } catch (error) {
    return { installed: error.code !== 'ENOENT', connected: false, email: null, plan: null }
  }
}
