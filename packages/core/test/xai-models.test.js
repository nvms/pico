import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadXAIModels, mapXAIModels } from '../src/xai-models.js'

test('subscription models remain separate from paid API models', () => {
  const models = mapXAIModels([{ id: 'grok-build', context_window: 128000 }, { id: 'grok-imagine-image' }])
  assert.equal(models.length, 1)
  assert.equal(models[0].name, 'grok/grok-build')
  assert.equal(models[0].provider, 'grok')
  assert.equal(models[0].price, null)
  assert.equal(models[0].context, 128000)
})

test('OAuth discovery uses only the subscription catalog and caches offline', async t => {
  const previous = process.env.PICO_HOME
  const home = await mkdtemp(join(tmpdir(), 'pico-xai-'))
  process.env.PICO_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  assert.deepEqual(await loadXAIModels(null), [])
  const calls = []
  const fetcher = async (url, options) => {
    calls.push(url)
    assert.equal(options.headers.Authorization, 'Bearer subscription-token')
    return { ok: true, json: async () => ({ data: [{ id: url.includes('cli-chat') ? 'grok-composer' : 'grok-build' }] }) }
  }
  const models = await loadXAIModels({ accessToken: 'subscription-token' }, { fetcher })
  assert.deepEqual(calls, ['https://cli-chat-proxy.grok.com/v1/models'])
  assert.equal(models.length, 1)
  assert.deepEqual(await loadXAIModels(null), models)
  const failing = async () => { throw new Error('offline') }
  assert.deepEqual(await loadXAIModels({ accessToken: 'token' }, { force: true, fetcher: failing }), models)
})
