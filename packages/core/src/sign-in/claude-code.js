// Claude Code's sign-in, as pico keeps it: the long-lived token
// `claude setup-token` makes (../claude-code/token.js), so pico does not
// depend on, or disturb, the login `claude` keeps itself. The token is
// also handed back, for a host that keeps it elsewhere.

import { homedir } from 'node:os'
import { claudeCodeStatus, claudeCommand } from '../claude-code/models.js'
import { forgetClaudeToken, keepClaudeToken } from '../claude-code/token.js'
import { flat, lastSaid, runOnScreen } from './screen.js'

const TOKEN = /sk-ant-oat[0-9]+-[A-Za-z0-9_-]{20,}/
const LINK = /https:\/\/\S+\/oauth\/authorize\?\S*state=\S+/

export const status = async () => {
  const claude = await claudeCodeStatus()
  return { installed: claude.installed, signedIn: claude.connected, identity: claude.email }
}

// `keep: false` hands the token back without keeping it, for a host that keeps it itself
export async function start({ keep = true } = {}) {
  const command = claudeCommand()
  if (!command) throw new Error('Claude Code is not installed')
  const env = { ...process.env }
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  const run = runOnScreen(command, ['setup-token'], { env, cwd: homedir() })
  let settled = false
  let cancelled = false
  const found = (screen) => flat(screen).match(TOKEN)?.[0] ?? null
  const page = new Promise((resolve) => {
    const check = (screen) => { const url = flat(screen).match(LINK)?.[0]; if (url) { off(); resolve({ url }) } }
    const off = run.onScreen(check)
  })
  const done = new Promise((resolve, reject) => {
    const off = run.onScreen((screen) => {
      const token = found(screen)
      if (!token || settled) return
      settled = true
      off()
      if (keep) keepClaudeToken(token)
      resolve({ identity: null, token })
      setTimeout(() => run.kill(), 500)
    })
    run.exited.then(() => {
      if (settled) return
      settled = true
      // a token printed just before it stopped is still taken
      const token = found(run.screen)
      if (token) { if (keep) keepClaudeToken(token); resolve({ identity: null, token }) }
      else if (cancelled) reject(new Error('cancelled'))
      else reject(new Error(`Claude Code stopped without a token. It last said: ${lastSaid(run.screen)}`))
    })
  })
  done.catch(() => {})
  return {
    page,
    input: 'code',
    done,
    // the code from Claude's page goes in, and the answer is waited for:
    // a token, or Claude refusing the code
    finish: (code) => new Promise((resolve, reject) => {
      const from = run.screen.length
      const check = setInterval(() => {
        if (settled) { clearInterval(check); resolve(); return }
        if (/retry|invalid|expired|error|failed/i.test(flat(run.screen.slice(from)))) { clearInterval(check); reject(new Error('Claude did not accept that code. Copy the whole code from the page and try again.')) }
      }, 250)
      setTimeout(() => { clearInterval(check); if (!settled) reject(new Error(`Claude did not answer. It last said: ${lastSaid(run.screen)}`)) }, 45000)
      run.type(String(code).trim())
    }),
    cancel() { cancelled = true; run.kill() },
  }
}

export const signOut = async () => forgetClaudeToken()
