import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapCodexModels, loadCodexModels } from '../src/codex-models.js'

test('maps backend entries to picker models', () => {
  const models = mapCodexModels([
    { slug: 'gpt-5.6-sol', description: 'Latest frontier agentic coding model.', context_window: 272000 },
    { slug: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  ])
  assert.equal(models[0].context, 272000)
  assert.equal(models[1].context, null)
  assert.equal(models[0].name, 'codex/gpt-5.6-sol')
  assert.equal(models[0].provider, 'codex')
  assert.match(models[0].desc, /via ChatGPT plan/)
  assert.equal(models[0].price, null)
  assert.equal(models[0].effort, true)
  assert.match(models[1].desc, /GPT-5.3-Codex-Spark/)
})

test('forced load bypasses a fresh codex cache', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(process.env.PICO_HOME, { recursive: true })
  await writeFile(
    join(process.env.PICO_HOME, 'codex-models-cache.json'),
    JSON.stringify({ at: Date.now(), models: [{ slug: 'cached' }] }),
  )
  const models = await loadCodexModels(
    { apiKey: 'token', headers: {} },
    { force: true, fetcher: async () => ({ ok: true, json: async () => ({ models: [{ slug: 'fresh' }] }) }) },
  )
  assert.deepEqual(models.map((model) => model.name), ['codex/fresh'])
  delete process.env.PICO_HOME
})

test('no credentials and no cache means no codex rows, cache serves offline', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  assert.deepEqual(await loadCodexModels(null), [])

  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(process.env.PICO_HOME, { recursive: true })
  await writeFile(
    join(process.env.PICO_HOME, 'codex-models-cache.json'),
    JSON.stringify({ at: Date.now(), models: [{ slug: 'gpt-5.6-terra', description: 'cached' }] }),
  )
  const cached = await loadCodexModels(null)
  assert.equal(cached.length, 1)
  assert.equal(cached[0].name, 'codex/gpt-5.6-terra')
  delete process.env.PICO_HOME
})

test('Fast capability follows advertised Codex tiers, not the model name', () => {
  const models = mapCodexModels([
    { slug: 'supported', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    { slug: 'alternate', additional_speed_tiers: ['fast'] },
    { slug: 'gpt-6.1-sol' },
    { slug: 'standard', service_tiers: [{ id: 'default' }] },
  ])
  assert.deepEqual(models.map(model => model.speed), [true, true, false, false])
})

test('fetch and cache preserve advertised Fast capability', async t => {
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-speed-cache-'))
  t.after(() => {
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
  })
  const models = await loadCodexModels({ apiKey: 'token' }, {
    force: true,
    fetcher: async () => ({ ok: true, json: async () => ({ models: [
      { slug: 'supported', service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] },
    ] }) }),
  })
  assert.equal(models[0].speed, true)
  const cached = await loadCodexModels(null)
  assert.equal(cached[0].speed, true)
})

test('a fresh cache without speed metadata is refreshed', async t => {
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-speed-upgrade-'))
  t.after(() => {
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
  })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(process.env.PICO_HOME, 'codex-models-cache.json'), JSON.stringify({ at: Date.now(), models: [{ slug: 'supported' }] }))
  let fetched = false
  const models = await loadCodexModels({ apiKey: 'test' }, {
    fetcher: async () => {
      fetched = true
      return { ok: true, json: async () => ({ models: [{ slug: 'supported', service_tiers: [{ id: 'priority' }] }] }) }
    },
  })
  assert.equal(fetched, true)
  assert.equal(models[0].speed, true)
})
