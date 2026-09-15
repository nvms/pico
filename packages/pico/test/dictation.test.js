import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createDictation } from '../src/dictation.js'
import { createDictationInput } from '../src/ui/dictation-input.js'

function fixture(options = {}) {
  const children = []
  const errors = []
  const statuses = []
  const dictation = createDictation({
    platform: 'darwin', arch: 'arm64', onStatus: (s) => statuses.push(s), onError: (e) => errors.push(e),
    launch: () => {
      const child = new EventEmitter()
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), requests: [], killed: false })
      child.kill = () => { child.killed = true }
      child.stdin.on('data', (data) => child.requests.push(JSON.parse(data)))
      child.reply = (message) => child.stdout.write(JSON.stringify(message) + '\n')
      children.push(child)
      return child
    }, ...options,
  })
  return { dictation, children, errors, statuses }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function recording(f) {
  const starting = f.dictation.start()
  const child = f.children.at(-1)
  child.reply({ status: 'ready' })
  await tick()
  child.reply({ id: child.requests.at(-1).id })
  await starting
  assert.equal(f.dictation.status, 'recording')
  return child
}

test('loads lazily, handles split JSON, transcribes and reuses the helper', async () => {
  const f = fixture()
  assert.equal(f.children.length, 0)
  const starting = f.dictation.start()
  const child = f.children[0]
  child.stdout.write('log output\n{"status":')
  child.stdout.write('"ready"}\n')
  await tick()
  assert.equal(child.requests[0].op, 'start')
  child.reply({ id: child.requests[0].id })
  await starting
  const stopping = f.dictation.stop()
  assert.equal(f.dictation.status, 'transcribing')
  child.reply({ id: child.requests[1].id, text: 'hello' })
  assert.equal(await stopping, 'hello')
  const next = f.dictation.start()
  await tick()
  child.reply({ id: child.requests[2].id })
  await next
  assert.equal(f.children.length, 1)
  f.dictation.dispose()
  assert.equal(child.killed, true)
})

test('preloading stays idle, sends no commands and reuses the helper', async () => {
  const f = fixture()
  const loading = f.dictation.preload()
  const again = f.dictation.preload()
  const child = f.children[0]
  assert.equal(f.dictation.status, 'idle')
  assert.deepEqual(f.statuses, [])
  assert.equal(f.children.length, 1)
  assert.deepEqual(child.requests, [])
  child.reply({ status: 'ready' })
  await Promise.all([loading, again])
  assert.deepEqual(child.requests, [])
  await recording(f)
  assert.equal(f.children.length, 1)
  f.dictation.dispose()
})

test('starting during preload shares readiness and starts recording once', async () => {
  const f = fixture()
  const loading = f.dictation.preload()
  await recording(f)
  await loading
  assert.equal(f.children.length, 1)
  assert.deepEqual(f.children[0].requests.map((r) => r.op), ['start'])
  f.dictation.dispose()
})

test('background failures are silent and a hotkey can retry', async () => {
  for (const fail of [
    (child) => child.emit('error', new Error('ENOENT')),
    (child) => child.emit('exit', 1),
    (child) => child.reply({ status: 'error', message: 'model download failed' }),
  ]) {
    const f = fixture()
    const loading = f.dictation.preload()
    fail(f.children[0])
    await loading
    assert.deepEqual(f.errors, [])
    assert.equal(f.children[0].killed, true)
    await recording(f)
    assert.equal(f.children.length, 2)
    f.dictation.dispose()
  }
})

test('preload timeouts and unsupported platforms stay quiet', async () => {
  for (const options of [{ loadingTimeout: 10 }, { platform: 'linux' }, { arch: 'x64' }, { launch: () => { throw new Error('spawn failed') } }]) {
    const f = fixture(options)
    await f.dictation.preload()
    assert.deepEqual(f.errors, [])
    assert.equal(f.dictation.status, 'idle')
    f.dictation.dispose()
  }
})

test('quitting during preload kills the helper and prevents further launches', async () => {
  for (const start of [false, true]) {
    const f = fixture()
    const loading = f.dictation.preload()
    const starting = start ? f.dictation.start() : null
    const child = f.children[0]
    f.dictation.dispose()
    child.reply({ status: 'ready' })
    await Promise.all([loading, starting])
    await f.dictation.preload()
    await f.dictation.start()
    assert.equal(child.killed, true)
    assert.equal(child.stdin.writableEnded, true)
    assert.equal(f.children.length, 1)
    assert.deepEqual(child.requests, [])
    assert.deepEqual(f.errors, [])
  }
  const f = fixture()
  f.dictation.dispose()
  await f.dictation.preload()
  assert.equal(f.children.length, 0)
})

test('cancellation during loading rejects stale readiness without an error', async () => {
  const f = fixture()
  const starting = f.dictation.start()
  await f.dictation.cancel()
  f.children[0].reply({ status: 'ready' })
  await starting
  assert.equal(f.dictation.status, 'idle')
  assert.deepEqual(f.children[0].requests, [])
  assert.deepEqual(f.errors, [])
})

test('recording cancellation keeps loaded models alive', async () => {
  const f = fixture()
  const child = await recording(f)
  const cancelling = f.dictation.cancel()
  assert.equal(child.requests.at(-1).op, 'cancel')
  child.reply({ id: child.requests.at(-1).id })
  await cancelling
  assert.equal(child.killed, false)
  assert.equal(f.dictation.status, 'idle')
  f.dictation.dispose()
})

test('cancelling transcription discards the result', async () => {
  const f = fixture()
  const child = await recording(f)
  const stopping = f.dictation.stop()
  await f.dictation.cancel()
  child.reply({ id: child.requests.at(-1).id, text: 'discard' })
  assert.equal(await stopping, null)
  assert.deepEqual(f.errors, [])
})

test('helper spawn failure is visible and retryable', async () => {
  const f = fixture()
  const starting = f.dictation.start()
  f.children[0].emit('error', new Error('ENOENT'))
  await starting
  assert.match(f.errors[0], /unavailable.*ENOENT/)
  assert.equal(f.dictation.status, 'idle')
  await recording(f)
  f.dictation.dispose()
})

test('helper death while recording is visible', async () => {
  const f = fixture()
  const child = await recording(f)
  child.emit('exit', 1)
  assert.deepEqual(f.errors, ['dictation helper exited'])
  assert.equal(f.dictation.status, 'idle')
})

test('permission and model errors are surfaced', async () => {
  const f = fixture()
  const starting = f.dictation.start()
  f.children[0].reply({ status: 'error', message: 'model download failed' })
  await starting
  assert.deepEqual(f.errors, ['model download failed'])
  const retry = f.dictation.start()
  const child = f.children[1]
  child.reply({ status: 'ready' })
  await tick()
  child.reply({ id: child.requests[0].id, error: 'microphone access denied' })
  await retry
  assert.equal(f.errors.at(-1), 'microphone access denied')
})

test('loading and transcription have bounded waits', async () => {
  const loading = fixture({ loadingTimeout: 10 })
  await loading.dictation.start()
  assert.deepEqual(loading.errors, ['dictation timed out'])
  const f = fixture({ requestTimeout: 10 })
  await recording(f)
  assert.equal(await f.dictation.stop(), null)
  assert.deepEqual(f.errors, ['dictation timed out'])
})

test('unsupported platforms do not launch a helper', async () => {
  const f = fixture({ platform: 'linux' })
  await f.dictation.start()
  assert.equal(f.children.length, 0)
  assert.match(f.errors[0], /Apple Silicon/)
})

function editorFixture() {
  const f = fixture()
  let value = 'hello world'
  const input = createDictationInput({ dictation: f.dictation, getInput: () => value, setInput: (v) => { value = v } })
  return { ...f, input, get value() { return value }, set value(v) { value = v } }
}

async function startEditor(f) {
  f.input.start({ value: f.value, cursor: 6 })
  const child = f.children[0]
  child.reply({ status: 'ready' })
  await tick()
  child.reply({ id: child.requests[0].id })
  await tick()
  return child
}

test('Enter transcribes at the captured cursor without submitting', async () => {
  const f = editorFixture()
  const child = await startEditor(f)
  assert.equal(f.input.handle({ key: 'return' }), true)
  assert.equal(f.input.handle({ key: 'return' }), true)
  assert.equal(child.requests.filter((r) => r.op === 'stop').length, 1)
  child.reply({ id: child.requests.at(-1).id, text: 'beautiful ' })
  await tick()
  assert.equal(f.value, 'hello beautiful world')
  assert.equal(f.input.handle({ key: 'return' }), false)
  f.dictation.dispose()
})

test('Escape cancels without altering draft or interrupting an agent', async () => {
  const f = editorFixture()
  const child = await startEditor(f)
  assert.equal(f.input.handle({ key: 'escape' }), true)
  child.reply({ id: child.requests.at(-1).id })
  await tick()
  assert.equal(f.value, 'hello world')
  f.dictation.dispose()
})

test('changed drafts and session cancellation reject stale transcripts', async () => {
  for (const cancel of [false, true]) {
    const f = editorFixture()
    const child = await startEditor(f)
    f.input.handle({ key: 'return' })
    if (cancel) f.input.cancel()
    f.value = 'new session draft'
    child.reply({ id: child.requests.at(-1).id, text: 'stale' })
    await tick()
    assert.equal(f.value, 'new session draft')
    f.dictation.dispose()
  }
})

test('dictation adds a separator only when needed at the cursor', async () => {
  for (const [value, text, expected, cursor = value.length] of [
    ['Hello.', 'This is a test', 'Hello. This is a test'],
    ['Hello. ', 'This is a test', 'Hello. This is a test'],
    ['Hello.\n', 'This is a test', 'Hello.\nThis is a test'],
    ['', 'Hello.', 'Hello.'],
    ['Hello.', '', 'Hello.'],
    ['Hello.', ' This is a test', 'Hello. This is a test'],
    ['Hello. world', 'Beautiful', 'Hello. Beautiful world', 6],
    ['world', 'Hello. ', 'Hello. world', 0],
  ]) {
    let draft = value
    const dictation = { status: 'idle', start() { this.status = 'recording' }, async stop() { return text } }
    const input = createDictationInput({ dictation, getInput: () => draft, setInput: (v) => { draft = v } })
    input.start({ value, cursor })
    input.handle({ key: 'return' })
    await tick()
    assert.equal(draft, expected)
  }
})

test('only live recording forwards finite microphone levels', async () => {
  const levels = []
  const f = fixture({ onLevel: (level) => levels.push(level) })
  const child = await recording(f)
  child.reply({ status: 'level', level: 0.5 })
  child.reply({ status: 'level', level: 2 })
  child.reply({ status: 'level', level: 'bad' })
  assert.deepEqual(levels, [0.5, 1])
  const stopping = f.dictation.stop()
  child.reply({ status: 'level', level: 0.8 })
  child.reply({ id: child.requests.at(-1).id, text: 'Um, this is, uh, a test.' })
  assert.equal(await stopping, 'This is a test.')
  child.reply({ status: 'level', level: 0.9 })
  assert.deepEqual(levels, [0.5, 1])
  f.dictation.dispose()
})
