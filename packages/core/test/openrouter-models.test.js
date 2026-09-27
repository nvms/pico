import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOpenRouterModels, mapOpenRouterModels, slimOpenRouterModels } from '../src/openrouter-models.js'

const entry = (id, extra = {}) => ({
  id,
  name: `Name ${id}`,
  created: 1,
  context_length: 200000,
  pricing: { prompt: '0.000002', completion: '0.00001' },
  supported_parameters: ['tools', 'reasoning'],
  architecture: { input_modalities: ['text', 'image'] },
  ...extra,
})

const usePicoHome = async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  await mkdir(process.env.PICO_HOME, { recursive: true })
}

test('keeps only tool-capable chat models and drops batch-only twins', () => {
  const slim = slimOpenRouterModels([
    entry('a/tools'),
    entry('a/tools:batch'),
    entry('a/no-tools', { supported_parameters: ['reasoning'] }),
    entry('a/tools:free'),
  ])
  assert.deepEqual(slim.map((m) => m.id), ['a/tools', 'a/tools:free'])
})

test('maps to picker models with per-million prices, newest first', () => {
  const models = mapOpenRouterModels(slimOpenRouterModels([
    entry('old/model', { created: 1 }),
    entry('new/model', { created: 2, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }),
    entry('openrouter/auto', { created: 0, pricing: { prompt: '-1', completion: '-1' } }),
  ]))
  assert.deepEqual(models.map((m) => m.name), ['openrouter/new/model', 'openrouter/old/model', 'openrouter/openrouter/auto'])
  assert.deepEqual(models[1].price, { in: 2, out: 10 })
  assert.equal(models[1].provider, 'openrouter')
  assert.equal(models[1].effort, true)
  assert.equal(models[1].vision, true)
  assert.equal(models[1].context, 200000)
  assert.equal(models[0].effort, false)
  assert.equal(models[0].vision, false)
  assert.equal(models[2].price, null)
})

test('serves a fresh cache without fetching and falls back to it offline', async () => {
  await usePicoHome()
  const cachePath = join(process.env.PICO_HOME, 'openrouter-models-cache.json')
  const failing = async () => { throw new Error('offline') }
  await writeFile(cachePath, JSON.stringify({ at: Date.now(), models: slimOpenRouterModels([entry('c/cached')]) }))
  assert.deepEqual((await loadOpenRouterModels({ fetcher: failing })).map((m) => m.name), ['openrouter/c/cached'])

  await writeFile(cachePath, JSON.stringify({ at: 0, models: slimOpenRouterModels([entry('c/stale')]) }))
  assert.deepEqual((await loadOpenRouterModels({ fetcher: failing })).map((m) => m.name), ['openrouter/c/stale'])
  delete process.env.PICO_HOME
})

test('forced load fetches past a fresh cache and reports failure', async () => {
  await usePicoHome()
  await writeFile(
    join(process.env.PICO_HOME, 'openrouter-models-cache.json'),
    JSON.stringify({ at: Date.now(), models: slimOpenRouterModels([entry('c/cached')]) }),
  )
  const fresh = await loadOpenRouterModels({
    force: true,
    fetcher: async () => ({ ok: true, json: async () => ({ data: [entry('f/fresh')] }) }),
  })
  assert.deepEqual(fresh.map((m) => m.name), ['openrouter/f/fresh'])
  await assert.rejects(loadOpenRouterModels({ force: true, fetcher: async () => ({ ok: false, status: 503 }) }), /503/)
  delete process.env.PICO_HOME
})
