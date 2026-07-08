import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendPrompt, loadProjectPrompts, loadGlobalPrompts } from '../src/core/history.js'

test('prompt history round trip per project and globally', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const rootA = await mkdtemp(join(tmpdir(), 'pico-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'pico-b-'))

  await appendPrompt(rootA, 'first prompt in a')
  await appendPrompt(rootA, 'second prompt in a')
  await appendPrompt(rootB, 'prompt in b')

  const project = await loadProjectPrompts(rootA)
  assert.deepEqual(project.map((p) => p.text), ['first prompt in a', 'second prompt in a'])
  assert.ok(project.every((p) => p.scope === 'project' && p.at > 0))

  const global = await loadGlobalPrompts()
  assert.equal(global.length, 3)
  assert.ok(global.some((p) => p.text === 'prompt in b'))

  assert.deepEqual(await loadProjectPrompts(await mkdtemp(join(tmpdir(), 'pico-c-'))), [])
  delete process.env.PICO_HOME
})
