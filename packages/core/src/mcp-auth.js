// Signing in to MCP servers that use OAuth, as the MCP specification lays
// out: the server's sign-in service is discovered, pico registers itself
// with it, the person approves in their browser, and the tokens that come
// back are kept and refreshed. One sign-in per server address, kept under
// pico's home, serves every session on this machine.

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { picoHome } from './paths.js'

const SIGN_IN_MS = 5 * 60 * 1000

const authDir = () => join(picoHome(), 'mcp-auth')
const authFile = (url) => join(authDir(), `${createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}.json`)

function load(url) {
  try {
    return JSON.parse(readFileSync(authFile(url), 'utf8'))
  } catch {
    return {}
  }
}

function store(url, patch) {
  mkdirSync(authDir(), { recursive: true, mode: 0o700 })
  writeFileSync(authFile(url), JSON.stringify({ ...load(url), ...patch, url: String(url) }, null, 2), { mode: 0o600 })
}

export const hasSignIn = (url) => !!load(url).tokens

export function signOut(url) {
  rmSync(authFile(url), { force: true })
}

// a connection that is not signing in still names a callback, or the SDK
// takes it for a machine-to-machine client; nothing listens there
const NOWHERE = 'http://127.0.0.1/callback'

// what the SDK asks of an app signing in. Outside a sign-in it only uses
// what is kept, and a server wanting a fresh sign-in is reported as such
export function authProvider(url, { redirectUrl = null, onAuthorize = null, state = null } = {}) {
  const signingIn = !!redirectUrl
  redirectUrl ??= NOWHERE
  return {
    get redirectUrl() { return redirectUrl },
    get clientMetadata() {
      return {
        client_name: 'pico',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    ...(state ? { state: () => state } : {}),
    // a registration made for another callback address cannot be used for this one
    clientInformation() {
      const client = load(url).client
      if (!client) return undefined
      if (signingIn && !(client.redirect_uris ?? []).includes(redirectUrl)) return undefined
      return client
    },
    saveClientInformation: (client) => store(url, { client }),
    tokens: () => load(url).tokens,
    saveTokens: (tokens) => store(url, { tokens }),
    saveCodeVerifier: (verifier) => store(url, { verifier }),
    codeVerifier: () => load(url).verifier,
    async redirectToAuthorization(authorizationUrl) {
      if (onAuthorize) await onAuthorize(String(authorizationUrl))
    },
    invalidateCredentials(scope) {
      const kept = load(url)
      if (scope === 'all') return signOut(url)
      if (scope === 'tokens') delete kept.tokens
      if (scope === 'client') delete kept.client
      if (scope === 'verifier') delete kept.verifier
      mkdirSync(authDir(), { recursive: true, mode: 0o700 })
      writeFileSync(authFile(url), JSON.stringify(kept, null, 2), { mode: 0o600 })
    },
  }
}

export function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

// a browser sign-in, answered on a port of this machine's own; open is
// handed the address to send the person to
export async function signIn(url, { open = openBrowser, fetchFn } = {}) {
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
  const state = randomBytes(16).toString('hex')
  let deliver
  let fail
  const answered = new Promise((resolve, reject) => { deliver = resolve; fail = reject })
  const server = createServer((req, res) => {
    const reply = new URL(req.url, 'http://127.0.0.1')
    if (reply.pathname !== '/callback') { res.writeHead(404).end(); return }
    const error = reply.searchParams.get('error')
    // an answer to some other sign-in is not this one's
    const code = reply.searchParams.get('state') === state ? reply.searchParams.get('code') : null
    res.writeHead(code ? 200 : 400, { 'content-type': 'text/plain' })
    res.end(code ? 'Signed in. You can close this tab.' : `Sign-in failed: ${error || 'no code came back'}`)
    if (code) deliver(code)
    else fail(new Error(`sign-in failed: ${reply.searchParams.get('error_description') || error || 'no code came back'}`))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const timer = setTimeout(() => fail(new Error('no sign-in within 5 minutes')), SIGN_IN_MS)
  try {
    const provider = authProvider(url, { redirectUrl: `http://127.0.0.1:${server.address().port}/callback`, onAuthorize: open, state })
    if (await auth(provider, { serverUrl: url, fetchFn }) === 'AUTHORIZED') return
    const code = await answered
    await auth(provider, { serverUrl: url, authorizationCode: code, fetchFn })
  } finally {
    clearTimeout(timer)
    server.close()
  }
}
