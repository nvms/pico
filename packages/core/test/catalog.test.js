import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog } from '../src/catalog.js'

test('forced load bypasses a fresh model catalog cache', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  await mkdir(process.env.PICO_HOME, { recursive: true })
  await writeFile(
    join(process.env.PICO_HOME, 'models-cache.json'),
    JSON.stringify({ at: Date.now(), providers: { openai: { models: { cached: {} } } } }),
  )
  const providers = await loadCatalog({
    force: true,
    fetcher: async () => ({
      ok: true,
      json: async () => ({ openai: { models: { fresh: {} } } }),
    }),
  })
  assert.deepEqual(Object.keys(providers.openai.models), ['fresh'])
  delete process.env.PICO_HOME
})
