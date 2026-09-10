import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfig } from '../src/config.js'

test('legacy participant models migrate without overriding an explicitly cleared preference', async () => {
  const previous = process.env.PICO_HOME
  const home = await mkdtemp(join(tmpdir(), 'pico-config-test-'))
  process.env.PICO_HOME = home
  try {
    await writeFile(join(home, 'config.json'), JSON.stringify({ models: { proposer: 'model-a', reviewer: 'model-b' } }))
    assert.deepEqual((await readConfig()).models, { proposer: 'model-a', reviewer: 'model-b', participantA: 'model-a', participantB: 'model-b' })
    await writeConfig({ models: { participantA: null, participantB: 'model-c' } })
    const config = await readConfig()
    assert.equal(config.models.participantA, null)
    assert.equal(config.models.participantB, 'model-c')
  } finally {
    if (previous === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
