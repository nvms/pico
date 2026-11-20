// Signing this machine's agy in to a Google account, and out again. agy
// runs the whole sign-in itself, as it does in a terminal: it opens
// Google's page and listens on this machine for the page's answer. pico
// only catches the page's address, so a host can show it wherever the
// person is, and hands back the address the page ended on when the
// person signed in from another device. The login agy keeps stays agy's.

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize, spawnAgent } from '../acp/connect.js'
import { modelsOffered } from '../acp/translate.js'
import { agyEnv, pageCatcher } from '../antigravity/process.js'
import { agyCommand, antigravityStatus, writeCatalog } from '../antigravity/models.js'
import { forgetConversation } from '../antigravity/conversations.js'

const SUBSCRIPTION_REQUIRED = /SUBSCRIPTION_REQUIRED|eligib/i

function signInError(error) {
  const text = String(error?.message ?? error)
  if (SUBSCRIPTION_REQUIRED.test(text)) return new Error('This Google account has no Antigravity plan that allows sign-in here')
  if (/cancel/i.test(text)) return new Error('cancelled')
  if (/access_denied|denied access/i.test(text)) return new Error('Google sign-in was not approved')
  return new Error(text)
}

export const status = async () => {
  const s = await antigravityStatus()
  return { installed: s.installed, signedIn: s.connected, identity: null, ...(s.error ? { error: s.error } : {}) }
}

// begins a sign-in. `page` is Google's page to open; `done` settles when
// agy has signed in and opened a session with it, which is the only proof
// the sign-in works, and lists the models it may use
export async function start({ command = agyCommand() } = {}) {
  if (!command) throw new Error('The Antigravity CLI is not installed')
  const catcher = pageCatcher()
  const cwd = mkdtempSync(join(tmpdir(), 'pico-agy-signin-'))
  let exit = null
  const agy = spawnAgent({ command, args: ['acp'], cwd, env: agyEnv(catcher.env(process.env)), onExit: (e) => { exit = e } })
  const cleanup = () => { agy.close(); catcher.close(); rmSync(cwd, { recursive: true, force: true }) }
  // where Google's page sends the browser back to, and the sign-in it belongs to
  let redirect = null
  let state = null

  const page = (async () => {
    await initialize(agy)
    const url = await catcher.next()
    const params = new URL(url).searchParams
    redirect = new URL(params.get('redirect_uri'))
    state = params.get('state')
    return { url }
  })()

  const done = (async () => {
    await initialize(agy)
    try {
      await agy.request('authenticate', { methodId: 'oauth-personal' })
    } catch (error) {
      throw signInError(exit?.error ?? error)
    }
    try {
      const session = await agy.request('session/new', { cwd, mcpServers: [] })
      const models = modelsOffered(session?.configOptions)
      if (models.length) writeCatalog(models)
      await agy.request('session/close', { sessionId: session.sessionId }).catch(() => {})
      forgetConversation(session.sessionId)
      return { identity: null, models }
    } catch (error) {
      throw signInError(error)
    }
  })()
  done.then(cleanup, cleanup)
  page.catch(() => {})

  return {
    page,
    input: 'redirect',
    done,
    // the address Google's page ended on, from a browser on another
    // device, passed on to the listener agy keeps on this machine
    async finish(address) {
      await page
      let back
      try { back = new URL(String(address).trim()) } catch { throw new Error('That is not the address the page ended on') }
      const sameListener = ['localhost', '127.0.0.1', '[::1]'].includes(back.hostname) && back.port === redirect.port && back.pathname === redirect.pathname
      if (!sameListener) throw new Error('That is not the address the page ended on')
      if (back.searchParams.get('state') !== state) throw new Error('That address is from another sign-in; sign in again')
      if (!back.searchParams.has('code') && !back.searchParams.has('error')) throw new Error('That address has no answer from Google in it')
      const response = await fetch(`http://${redirect.host}${back.pathname}${back.search}`, { signal: AbortSignal.timeout(10000) }).catch(() => null)
      if (!response) throw new Error('The sign-in on this machine has already ended; sign in again')
    },
    cancel: cleanup,
  }
}

// signs agy out of its Google account on this machine
export async function signOut({ command = agyCommand() } = {}) {
  if (!command) return
  const cwd = mkdtempSync(join(tmpdir(), 'pico-agy-signout-'))
  const agy = spawnAgent({ command, args: ['acp'], cwd, env: agyEnv() })
  try {
    await initialize(agy)
    await agy.request('logout', {})
  } finally {
    agy.close()
    rmSync(cwd, { recursive: true, force: true })
  }
  writeCatalog([])
}

// Google's own installer for the Antigravity CLI, run as Google says to run it
const INSTALLER = 'https://antigravity.google/cli/install.sh'
export function install() {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', `curl -fsSL '${INSTALLER}' | bash`], { cwd: homedir(), timeout: 600000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`The Antigravity installer failed: ${String(stderr || stdout || error.message).trim().split('\n').at(-1)}`))
      else resolve()
    })
  })
}
