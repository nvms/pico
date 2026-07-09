import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapCodexModels, loadCodexModels } from '../src/core/codex-models.js'

test('maps backend entries to picker models', () => {
  const models = mapCodexModels([
    { slug: 'gpt-5.6-sol', description: 'Latest frontier agentic coding model.' },
    { slug: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  ])
  assert.equal(models[0].name, 'codex/gpt-5.6-sol')
  assert.equal(models[0].provider, 'codex')
  assert.match(models[0].desc, /via ChatGPT plan/)
  assert.equal(models[0].price, null)
  assert.equal(models[0].effort, true)
  assert.match(models[1].desc, /GPT-5.3-Codex-Spark/)
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
