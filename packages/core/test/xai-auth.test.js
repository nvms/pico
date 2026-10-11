import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectXAI, disconnectXAI, xaiConnected, xaiCredentials, xaiUsage } from '../src/xai-auth.js'

let home, previousHome, previousFetch
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })
const endpoint = 'https://auth.x.ai/oauth2/token'
const stored = () => ({ access_token: 'old', refresh_token: 'refresh', expires_at: 0, email: 'a@example.com', token_endpoint: endpoint })
const save = auth => writeFile(join(home, 'xai-auth.json'), JSON.stringify(auth))
const read = async () => JSON.parse(await readFile(join(home, 'xai-auth.json'), 'utf8'))
beforeEach(async () => {
  previousHome = process.env.PICO_HOME
  previousFetch = globalThis.fetch
  home = await mkdtemp(join(tmpdir(), 'pico-xai-test-'))
  process.env.PICO_HOME = home
})
afterEach(async () => {
  globalThis.fetch = previousFetch
  if (previousHome === undefined) delete process.env.PICO_HOME
  else process.env.PICO_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

test('missing credentials and independent disconnect', async () => {
  assert.deepEqual(await xaiConnected(), { connected: false, email: null })
  assert.equal(await xaiCredentials(), null)
  await writeFile(join(home, 'auth.json'), 'unrelated')
  await save({ xai: stored(), other: { secret: 'keep' } })
  await disconnectXAI()
  assert.deepEqual(await read(), { other: { secret: 'keep' } })
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'unrelated')
  assert.equal((await stat(join(home, 'xai-auth.json'))).mode & 0o777, 0o600)
})

test('device authorization uses discovered endpoints and exposes user code', async () => {
  const jwt = `header.${Buffer.from(JSON.stringify({ email: 'a@example.com' })).toString('base64url')}.signature`
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    if (url.includes('openid-configuration')) return json({ token_endpoint: endpoint, device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code' })
    const body = new URLSearchParams(options.body)
    assert.equal(body.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828')
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/device/code')) return json({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://auth.x.ai/device', expires_in: 30, interval: 1 })
    assert.equal(body.get('device_code'), 'device')
    return json({ access_token: 'access', refresh_token: 'refresh', id_token: jwt, expires_in: 3600 })
  }
  let presented
  assert.deepEqual(await connectXAI({ openBrowser: false, onUrl: (...args) => { presented = args } }), { email: 'a@example.com' })
  assert.deepEqual(presented, ['https://auth.x.ai/device', 'CODE'])
  assert.equal(calls, 3)
  assert.deepEqual(await xaiConnected(), { connected: true, email: 'a@example.com' })
  assert.deepEqual(await xaiCredentials(), { accessToken: 'access' })
})

test('concurrent refresh rotates once and preserves unrelated data', async () => {
  await save({ xai: stored(), other: 'keep' })
  let calls = 0
  globalThis.fetch = async (_, options) => {
    calls++
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'refresh')
    await new Promise(resolve => setTimeout(resolve, 50))
    return json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 })
  }
  const results = await Promise.all(Array.from({ length: 5 }, () => xaiCredentials()))
  assert.equal(calls, 1)
  assert.ok(results.every(result => result.accessToken === 'new'))
  assert.equal((await read()).xai.refresh_token, 'rotated')
  assert.equal((await read()).other, 'keep')
})

test('separate processes coordinate rotating refresh tokens', async () => {
  await save({ xai: stored() })
  const moduleUrl = new URL('../src/xai-auth.js', import.meta.url).href
  const script = `import { appendFile } from 'node:fs/promises';
    import { xaiCredentials } from ${JSON.stringify(moduleUrl)};
    globalThis.fetch = async () => {
      await appendFile(process.env.PICO_HOME + '/requests', 'refresh\\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));
    };
    console.log(JSON.stringify(await xaiCredentials()));`
  const run = promisify(execFile)
  const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--input-type=module', '-e', script], { env: process.env })))
  assert.ok(results.every(result => JSON.parse(result.stdout).accessToken === 'new'))
  assert.equal(await readFile(join(home, 'requests'), 'utf8'), 'refresh\n')
})

test('refresh failure preserves credentials and does not retry', async () => {
  const original = { xai: stored() }
  await save(original)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ error: 'invalid_grant' }, 400) }
  await assert.rejects(xaiCredentials(), /invalid_grant/)
  assert.equal(calls, 1)
  assert.deepEqual(await read(), original)
})

test('untrusted cached endpoint never receives refresh token', async () => {
  await save({ xai: { ...stored(), token_endpoint: 'https://evil.example/token' } })
  globalThis.fetch = () => { throw new Error('must not fetch') }
  await assert.rejects(xaiCredentials(), /Untrusted/)
})

test('timeout leaves existing authentication intact', async () => {
  await save({ xai: stored() })
  globalThis.fetch = async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  await assert.rejects(connectXAI({ openBrowser: false, timeoutMs: 30 }), /timed out/)
  assert.equal((await read()).xai.access_token, 'old')
})

test('billing normalizes weekly credits without inventing omitted quota', async () => {
  await save({ xai: { ...stored(), expires_at: Date.now() + 3600000 } })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
    assert.equal(options.headers.Authorization, 'Bearer old')
    return json({ subscription_tier: 'SuperGrok', config: { creditUsagePercent: 25, currentPeriod: { type: 'WEEKLY', end: '2026-10-12T00:00:00Z' } } })
  }
  assert.deepEqual(await xaiUsage(), { plan: 'SuperGrok', windows: [{ label: 'Weekly', usedPercent: 25, resetAt: Date.parse('2026-10-12T00:00:00Z') }] })
  globalThis.fetch = async () => json({ config: { currentPeriod: { type: 'WEEKLY' }, onDemandUsed: { val: '500' } } })
  assert.deepEqual((await xaiUsage()).windows, [])
})
