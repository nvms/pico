// The long-lived token Claude Code runs with, where pico keeps one: made
// by `claude setup-token` (sign-in/claude-code.js) for machines that
// cannot sign in interactively. A host that holds the token elsewhere
// passes it as CLAUDE_CODE_OAUTH_TOKEN instead, and Claude Code's own
// login is used when there is neither.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { picoHome } from '../paths.js'

const tokenFile = () => join(picoHome(), 'claude-token')

export function claudeToken(env = process.env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN
  try { return readFileSync(tokenFile(), 'utf8').trim() || null } catch { return null }
}

export function keepClaudeToken(token) {
  mkdirSync(picoHome(), { recursive: true })
  writeFileSync(tokenFile(), token, { mode: 0o600 })
}

export const forgetClaudeToken = () => rmSync(tokenFile(), { force: true })
