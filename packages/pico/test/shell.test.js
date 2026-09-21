import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandFromResponse, runShell } from '../src/shell.js'

const runtime = {
  providers: ['codex'],
  models: [{ name: 'codex/gpt-5.6-terra', provider: 'codex', available: true, effort: true }],
  codexCredentials: { apiKey: 'test' },
}

function output() {
  let value = ''
  return { stream: { write: (chunk) => { value += chunk } }, read: () => value }
}

test('accepts exactly one command', () => {
  assert.equal(commandFromResponse('  git status\n'), 'git status')
})

test('rejects invalid model output', () => {
  assert.throws(() => commandFromResponse(''), /empty/)
  assert.throws(() => commandFromResponse('git status\npwd'), /more than one line/)
  assert.throws(() => commandFromResponse('```sh git status ```'), /Markdown/)
  assert.throws(() => commandFromResponse('git\0status'), /more than one line/)
})

test('uses the configured shell model without tools', async () => {
  const stdout = output()
  const stderr = output()
  let call
  const status = await runShell({ prompt: 'show status' }, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    readConfig: async () => ({ defaultModel: 'other', models: { shell: 'codex/gpt-5.6-terra' } }),
    loadModelRuntime: async () => runtime,
    runTurn: async (options) => {
      call = options
      return { messages: [{ role: 'assistant', content: 'git status' }], interrupted: false }
    },
  })

  assert.equal(status, 0)
  assert.equal(stdout.read(), 'git status\n')
  assert.equal(stderr.read(), '')
  assert.equal(call.modelName, 'codex/gpt-5.6-terra')
  assert.deepEqual(call.tools, [])
  assert.deepEqual(call.history, [{ role: 'user', content: 'show status' }])
})

test('writes failures only to stderr', async () => {
  const stdout = output()
  const stderr = output()
  const status = await runShell({ prompt: 'show status' }, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    readConfig: async () => ({ models: { shell: 'codex/gpt-5.6-terra' } }),
    loadModelRuntime: async () => runtime,
    runTurn: async () => ({ messages: [{ role: 'assistant', content: 'command\nexplanation' }], interrupted: false }),
  })

  assert.equal(status, 1)
  assert.equal(stdout.read(), '')
  assert.match(stderr.read(), /^pico:/)
})
