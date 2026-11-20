// A terminal program's screen, read as text: what a sign-in that only
// runs in a terminal shows, through the system's `script` command, which
// gives it a terminal of its own without a native library. Wide enough
// that a long link is never wrapped, and so never read cut short.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

// everything a terminal program wrote, as plain characters: every escape
// sequence gone, and no line redrawn away
export const flat = (raw) => String(raw)
  .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_78=>])/g, '')
  .replace(/\r/g, '\n')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

// the last line a person would read there, anything token-like hidden
export const lastSaid = (raw) => flat(raw).split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && !/^[╭╰│─]+$/.test(l)).at(-1)?.replace(/[A-Za-z0-9_#-]{24,}/g, '…') ?? ''

// the programs a sign-in may open a web page with, stood in for by ones
// that do nothing: the page is shown where the person is, not here
const OPENERS = ['xdg-open', 'open', 'sensible-browser', 'x-www-browser', 'gnome-open', 'kde-open', 'wslview']

export function runOnScreen(command, args, { env = process.env, cwd } = {}) {
  const quiet = mkdtempSync(join(tmpdir(), 'pico-no-browser-'))
  for (const opener of OPENERS) writeFileSync(join(quiet, opener), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const line = `stty cols 4000 rows 40; exec ${[command, ...args].map(quote).join(' ')}`
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', line] : ['-qfec', line, '/dev/null']
  const child = spawn('script', scriptArgs, { cwd, env: { ...env, PATH: `${quiet}:${env.PATH ?? ''}`, BROWSER: join(quiet, 'xdg-open') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let screen = ''
  const listeners = new Set()
  const take = (chunk) => { screen += chunk; for (const listener of listeners) listener(screen) }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', take)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', take)
  child.stdin.on('error', () => {})
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }))
    child.on('exit', (code) => resolve({ code }))
  }).finally(() => rmSync(quiet, { recursive: true, force: true }))
  return {
    get screen() { return screen },
    onScreen(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    // typed, then submitted a moment later: Enter in the same burst would count as part of a paste
    type(text) {
      child.stdin.write(String(text))
      setTimeout(() => child.stdin.write('\r'), 400)
    },
    exited,
    kill() { try { child.kill('SIGTERM') } catch {} },
  }
}
