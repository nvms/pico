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

test('falls back to the curated lineup without credentials or cache', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const models = await loadCodexModels(null)
  assert.ok(models.length >= 7)
  assert.ok(models.some((m) => m.name === 'codex/gpt-5.6-terra'))
  assert.ok(models.every((m) => m.provider === 'codex'))
  delete process.env.PICO_HOME
})
