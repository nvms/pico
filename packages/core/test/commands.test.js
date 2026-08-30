import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandIndex, expandCommand, parseCommandArguments } from '../src/commands.js'

test('expandCommand substitutes or appends arguments', () => {
  assert.equal(expandCommand('review $ARGUMENTS carefully', 'src/app.js'), 'review src/app.js carefully')
  assert.equal(expandCommand('run the tests', 'and lint'), 'run the tests\n\nand lint')
  assert.equal(expandCommand('run the tests', ''), 'run the tests')
})

test('parses compact typed named arguments', () => {
  const body = '{{file:path:File to review}} {{focus:text}} {{mode:choice(review, fix):Mode}} {{focus:text:Ignored}}'
  assert.deepEqual(parseCommandArguments(body), [
    { name: 'file', type: 'path', label: 'File to review' },
    { name: 'focus', type: 'text', label: 'Focus' },
    { name: 'mode', type: 'choice', label: 'Mode', choices: ['review', 'fix'] },
  ])
  assert.deepEqual(parseCommandArguments('{{bad:choice():Bad}} {{9x:text}}'), [])
})

test('renders named values, validates choices, and preserves legacy arguments', () => {
  const body = 'Review {{file:path}} for {{focus:text:Focus}} in {{mode:choice(review,fix)}} mode. $ARGUMENTS'
  assert.equal(
    expandCommand(body, '--verbose', { file: 'src/a.js', focus: '<script>&', mode: 'fix' }),
    'Review src/a.js for <script>& in fix mode. --verbose',
  )
  assert.equal(expandCommand('{{x:text}}/{{x:text}}', { x: 'same' }), 'same/same')
  assert.equal(expandCommand('Value={{missing:text}}', {}), 'Value=')
  assert.throws(() => expandCommand('{{mode:choice(review,fix)}}', { mode: 'delete' }), /Invalid value/)
  assert.equal(expandCommand('literal {{bad:choice()}}', {}), 'literal {{bad:choice()}}')
})

test('command index scans both scopes, project wins, exposes fields, loads with args', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))

  await mkdir(join(process.env.PICO_HOME, 'commands'), { recursive: true })
  await writeFile(
    join(process.env.PICO_HOME, 'commands', 'review.md'),
    '---\ndescription: global review\n---\nreview $ARGUMENTS globally',
  )
  await mkdir(join(root, '.pico/commands'), { recursive: true })
  await writeFile(join(root, '.pico/commands', 'review.md'), 'review $ARGUMENTS locally')
  await writeFile(join(root, '.pico/commands', 'ship.md'), 'ship {{mode:choice(now,later):When}}')

  const index = await createCommandIndex(root)
  assert.deepEqual(index.list().map((c) => c.name).sort(), ['review', 'ship'])
  assert.equal(await index.load('review', 'the diff'), 'review the diff locally')
  const ship = index.list().find((command) => command.name === 'ship')
  assert.deepEqual(ship.arguments, [{ name: 'mode', type: 'choice', label: 'When', choices: ['now', 'later'] }])
  assert.equal(await index.load('ship', '', { mode: 'now' }), 'ship now')
  assert.equal(await index.load('missing'), null)
  delete process.env.PICO_HOME
})
