import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { setTimeout as sleep } from 'node:timers/promises'
import { picoHome } from './paths.js'

// Shared public client verified in OpenClaw extensions/xai/xai-oauth.ts and
// Hermes hermes_cli/auth_constants.py. xAI may display Grok Build at consent.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

function trustedEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))) {
    throw new Error('Untrusted xAI OAuth endpoint')
  }
  return url.href
}

async function locked(task) {
  const home = picoHome()
  await mkdir(home, { recursive: true })
  const file = join(home, 'xai-auth.json')
  let compromised
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: { retries: 3600, minTimeout: 100, maxTimeout: 100 },
    onCompromised: error => { compromised = error },
  })
  const assertLock = () => { if (compromised) throw compromised }
  try {
    return await task(file, assertLock)
  } finally {
    if (!compromised) await release()
  }
}

async function readAuth(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid xAI auth file')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function writeAuth(file, auth, assertLock) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(auth, null, 2) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    assertLock()
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function request(url, params, signal = AbortSignal.timeout(30000)) {
  const response = await fetch(trustedEndpoint(url), {
    method: params ? 'POST' : 'GET',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/json', ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(params ? { body: new URLSearchParams(params).toString() } : {}),
  })
  let data
  try { data = await response.json() } catch { throw new Error(`xAI returned invalid JSON (${response.status})`) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid xAI response')
  if (!response.ok || data.error) {
    const error = new Error(`xAI OAuth failed (${response.status}): ${typeof data.error === 'string' ? data.error : 'request rejected'}`)
    error.oauthCode = data.error
    throw error
  }
  return data
}

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) } catch { return {} }
}

function tokensInto(auth, tokens, endpoint, requireRefresh = false) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) throw new Error('xAI response missing access_token')
  if (requireRefresh && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token.trim())) throw new Error('xAI response missing refresh_token')
  const previous = auth.xai || {}
  const expires = Number(tokens.expires_in)
  const jwtExpiry = Number(claims(tokens.access_token).exp) * 1000
  const expiresAt = Number.isFinite(expires) && expires > 0 ? Date.now() + expires * 1000 : jwtExpiry
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('xAI response missing access token expiry')
  const identity = claims(tokens.id_token || tokens.access_token)
  auth.xai = {
    access_token: tokens.access_token,
    refresh_token: typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim() ? tokens.refresh_token : previous.refresh_token,
    email: typeof identity.email === 'string' ? identity.email : previous.email || null,
    expires_at: expiresAt,
    token_endpoint: endpoint,
  }
  return auth
}

function openInBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  execFile(command, [url], () => {})
}

export async function connectXAI({ onUrl = () => {}, openBrowser = true, timeoutMs = 300000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid xAI sign-in timeout')
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('xAI sign-in timed out')), timeoutMs)
  try {
    return await locked(async (file, assertLock) => {
      controller.signal.throwIfAborted()
      const discovery = await request(DISCOVERY, null, controller.signal)
      const endpoint = trustedEndpoint(discovery.token_endpoint)
      const device = await request(trustedEndpoint(discovery.device_authorization_endpoint), { client_id: CLIENT_ID, scope: SCOPE }, controller.signal)
      if (!device.device_code || !device.user_code || !device.verification_uri || !(Number(device.expires_in) > 0)) throw new Error('Invalid xAI device code response')
      const url = trustedEndpoint(device.verification_uri_complete || device.verification_uri)
      await onUrl(url, device.user_code)
      if (openBrowser) openInBrowser(url)
      const expiresAt = Math.min(deadline, Date.now() + Number(device.expires_in) * 1000)
      let interval = Math.max(1000, Number(device.interval) * 1000 || 5000)
      while (Date.now() < expiresAt) {
        await sleep(Math.min(interval, expiresAt - Date.now()), undefined, { signal: controller.signal })
        if (Date.now() >= expiresAt) break
        assertLock()
        try {
          const tokens = await request(endpoint, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: device.device_code,
          }, AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))]))
          controller.signal.throwIfAborted()
          const auth = tokensInto(await readAuth(file), tokens, endpoint, true)
          await writeAuth(file, auth, assertLock)
          return { email: auth.xai.email }
        } catch (error) {
          if (error.oauthCode === 'slow_down') interval += 5000
          else if (error.oauthCode !== 'authorization_pending') throw error
        }
      }
      throw new Error('xAI device code expired')
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function xaiConnected() {
  return locked(async file => {
    const { xai } = await readAuth(file)
    return { connected: !!(xai?.access_token && (xai.refresh_token || xai.expires_at > Date.now())), email: xai?.email || null }
  })
}

export async function xaiCredentials() {
  return locked(async (file, assertLock) => {
    const auth = await readAuth(file)
    const stored = auth.xai
    if (!stored?.access_token) return null
    if (!(stored.expires_at > Date.now() + 120000)) {
      if (!stored.refresh_token) return null
      const endpoint = stored.token_endpoint && stored.token_endpoint !== 'https://auth.x.ai/oauth/token'
        ? trustedEndpoint(stored.token_endpoint)
        : trustedEndpoint((await request(DISCOVERY)).token_endpoint)
      const tokens = await request(endpoint, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: stored.refresh_token })
      tokensInto(auth, tokens, endpoint)
      await writeAuth(file, auth, assertLock)
    }
    return { accessToken: auth.xai.access_token }
  })
}

export async function disconnectXAI() {
  return locked(async (file, assertLock) => {
    const auth = await readAuth(file)
    delete auth.xai
    await writeAuth(file, auth, assertLock)
  })
}

// Billing protocol: OpenClaw extensions/xai/usage.ts. Included subscription
// quota is separate from on-demand spending and prepaid balance.
export async function xaiUsage() {
  const credentials = await xaiCredentials()
  if (!credentials) return null
  const response = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
    redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json', 'x-grok-client-mode': 'cli', 'x-grok-client-version': '1.0.13' },
  })
  if (!response.ok) throw new Error(`xAI usage request failed (${response.status})`)
  const data = await response.json()
  const config = data?.config
  if (!config || typeof config !== 'object') throw new Error('Malformed xAI billing response')
  const cents = value => {
    const raw = value?.val
    if (raw === undefined || raw === null) return null
    if (!(typeof raw === 'number' || typeof raw === 'string' && /^\d+$/.test(raw))) return null
    const number = Number(raw)
    return Number.isSafeInteger(number) && number >= 0 ? number : null
  }
  const used = cents(config.used)
  const limit = cents(config.monthlyLimit ?? config.monthly_limit)
  const explicit = config.creditUsagePercent ?? config.credit_usage_percent
  const percent = typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0
    ? explicit : used !== null && limit > 0 ? used / limit * 100 : null
  const period = config.currentPeriod ?? config.current_period
  const end = period?.end ?? config.billingPeriodEnd ?? config.billing_period_end
  const reset = typeof end === 'string' ? Date.parse(end) : NaN
  return {
    plan: data.subscription_tier ?? data.subscriptionTier ?? 'SuperGrok',
    windows: percent === null ? [] : [{
      label: period?.type?.endsWith('WEEKLY') ? 'Weekly' : period?.type?.endsWith('MONTHLY') || limit !== null ? 'Monthly' : 'Usage',
      usedPercent: Math.min(100, percent), resetAt: Number.isFinite(reset) ? reset : null,
    }],
  }
}
