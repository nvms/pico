import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandIndex, expandCommand } from '../src/core/commands.js'

test('expandCommand substitutes or appends arguments', () => {
  assert.equal(expandCommand('review $ARGUMENTS carefully', 'src/app.js'), 'review src/app.js carefully')
  assert.equal(expandCommand('run the tests', 'and lint'), 'run the tests\n\nand lint')
  assert.equal(expandCommand('run the tests', ''), 'run the tests')
})

test('command index scans both scopes, project wins, loads with args', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))

  await mkdir(join(process.env.PICO_HOME, 'commands'), { recursive: true })
  await writeFile(
    join(process.env.PICO_HOME, 'commands', 'review.md'),
    '---\ndescription: global review\n---\nreview $ARGUMENTS globally',
  )
  await mkdir(join(root, '.pico/commands'), { recursive: true })
  await writeFile(join(root, '.pico/commands', 'review.md'), 'review $ARGUMENTS locally')
  await writeFile(join(root, '.pico/commands', 'ship.md'), 'ship it')

  const index = await createCommandIndex(root)
  assert.deepEqual(index.list().map((c) => c.name).sort(), ['review', 'ship'])
  assert.equal(await index.load('review', 'the diff'), 'review the diff locally')
  assert.equal(await index.load('ship'), 'ship it')
  assert.equal(await index.load('missing'), null)
  delete process.env.PICO_HOME
})
