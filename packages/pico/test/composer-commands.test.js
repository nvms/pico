import test from 'node:test'
import assert from 'node:assert/strict'
import { commandAt, replaceCommand, commandFields } from '../src/ui/composer-commands.js'
import { expandCommand, parseCommandArguments } from 'picocode-core/commands.js'

test('finds commands at the beginning, inline, and on subsequent lines', () => {
  for (const prefix of ['', 'please ', 'line one\n', '(']) {
    const text = `${prefix}/foo`
    assert.deepEqual(commandAt(text), { start: prefix.length, end: text.length, query: 'foo' })
  }
  for (const text of ['https://foo', '/tmp/foo', 'word/foo', '/foo ']) assert.equal(commandAt(text), null)
})

test('replaces only the command at the cursor, preserving both sides', () => {
  const text = 'before /foo right here /bar'
  const range = commandAt(text, 10)
  assert.deepEqual(range, { start: 7, end: 11, query: 'fo' })
  assert.deepEqual(replaceCommand(text, range, 'expanded\ntext'), {
    text: 'before expanded\ntext right here /bar', cursor: 20,
  })
})

test('expands typed arguments without sending or consuming surrounding prose', () => {
  const body = 'Write {{target:path:Target}} in {{style:choice(short,long):Style}} form: {{topic:text:Topic}}'
  const fields = commandFields({ arguments: parseCommandArguments(body) }, body)
  assert.deepEqual(fields.map((field) => field.type), ['path', 'choice', 'text'])
  const text = 'Please /distill right here'
  const expanded = expandCommand(body, '', { target: 'notes/file.md', style: 'short', topic: '$& details' })
  assert.equal(replaceCommand(text, commandAt(text, 15), expanded).text,
    'Please Write notes/file.md in short form: $& details right here')
})

test('collects legacy arguments alongside named fields unless already supplied', () => {
  const body = 'Review {{file:path:File}} for $ARGUMENTS'
  const command = { arguments: parseCommandArguments(body) }
  const fields = commandFields(command, body)
  assert.deepEqual(fields.map((field) => field.name), ['file', '$args'])
  assert.deepEqual(command.arguments.map((field) => field.name), ['file'])
  assert.deepEqual(commandFields(command, body, 'security').map((field) => field.name), ['file'])
  assert.equal(expandCommand(body, 'security', { file: 'src/app.js' }), 'Review src/app.js for security')
  assert.deepEqual(commandFields({}, 'Review $ARGUMENTS', 'security'), [])
})

test('supports legacy arguments and parameterless commands', () => {
  assert.deepEqual(commandFields({}, 'Summarize $ARGUMENTS'), [{ name: '$args', label: 'Arguments', type: 'text' }])
  assert.deepEqual(commandFields({}, 'Be brief'), [])
  assert.equal(expandCommand('Summarize $ARGUMENTS', 'the change'), 'Summarize the change')
})
