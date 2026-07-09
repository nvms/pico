import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_PORT = 1455
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const SCOPE = 'openid profile email offline_access'
const REFRESH_SKEW_MS = 5 * 60 * 1000

function authFile() {
  return join(picoHome(), 'auth.json')
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  } catch {
    return {}
  }
}

export function accountIdFromClaims(claims) {
  return claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.chatgpt_account_id || null
}

async function readAuth() {
  try {
    return JSON.parse(await readFile(authFile(), 'utf-8'))
  } catch {
    return {}
  }
}

async function writeAuth(auth) {
  ensureDir(picoHome())
  await writeFile(authFile(), JSON.stringify(auth, null, 2) + '\n')
  await chmod(authFile(), 0o600)
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  if (!response.ok) {
    throw new Error(`token request failed: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

function storeTokens(auth, tokens) {
  const claims = tokens.id_token ? decodeJwtClaims(tokens.id_token) : {}
  auth.openai = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || auth.openai?.refresh_token,
    id_token: tokens.id_token || auth.openai?.id_token,
    account_id: accountIdFromClaims(claims) || auth.openai?.account_id || null,
    email: claims.email || auth.openai?.email || null,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  }
  return auth
}

export async function connectOpenAI({ openBrowser = true, timeoutMs = 5 * 60 * 1000, onUrl = () => {} } = {}) {
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(24))

  const url = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  }).toString()}`

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
      if (requestUrl.pathname !== '/auth/callback') {
        res.writeHead(404).end()
        return
      }
      const gotState = requestUrl.searchParams.get('state')
      const gotCode = requestUrl.searchParams.get('code')
      const gotError = requestUrl.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        gotCode && gotState === state
          ? '<html><body style="font-family: sans-serif; padding: 2rem">signed in - you can return to pico</body></html>'
          : '<html><body style="font-family: sans-serif; padding: 2rem">sign-in failed - return to pico and try again</body></html>',
      )
      cleanup()
      if (gotError) reject(new Error(`authorization failed: ${gotError}`))
      else if (!gotCode || gotState !== state) reject(new Error('authorization failed: missing code or state mismatch'))
      else resolve(gotCode)
    })

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('sign-in timed out'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      server.close()
    }

    server.on('error', (err) => {
      cleanup()
      reject(err.code === 'EADDRINUSE' ? new Error(`port ${REDIRECT_PORT} is in use (is another sign-in or codex running?)`) : err)
    })
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      onUrl(url)
      if (openBrowser) execFile('open', [url], () => {})
    })
  })

  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })

  const auth = storeTokens(await readAuth(), tokens)
  await writeAuth(auth)
  return { email: auth.openai.email, accountId: auth.openai.account_id }
}

export async function openaiCredentials() {
  const auth = await readAuth()
  const stored = auth.openai
  if (!stored?.access_token) return null

  if (Date.now() > (stored.expires_at || 0) - REFRESH_SKEW_MS) {
    if (!stored.refresh_token) return null
    const tokens = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      client_id: CLIENT_ID,
      scope: 'openid profile email',
    })
    const refreshed = storeTokens(auth, tokens)
    await writeAuth(refreshed)
    return credentialsFrom(refreshed.openai)
  }
  return credentialsFrom(stored)
}

function credentialsFrom(stored) {
  return {
    apiKey: stored.access_token,
    headers: stored.account_id ? { 'chatgpt-account-id': stored.account_id } : {},
    email: stored.email,
  }
}

export async function openaiConnected() {
  const auth = await readAuth()
  return !!(auth.openai?.access_token && auth.openai?.refresh_token)
}

export async function openaiStatus() {
  const auth = await readAuth()
  return {
    connected: !!(auth.openai?.access_token && auth.openai?.refresh_token),
    email: auth.openai?.email || null,
  }
}

export async function disconnectOpenAI() {
  const auth = await readAuth()
  delete auth.openai
  await writeAuth(auth)
}
