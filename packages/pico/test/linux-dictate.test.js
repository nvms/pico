import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createLinuxDictation, runLinuxDictation, wavHeader } from '../helper/linux-dictate.js'

function fixture(options = {}) {
  const messages = [], calls = [], removed = [], writes = []
  const spawn = (binary, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', null)) }
    calls.push({ binary, args, child })
    queueMicrotask(() => {
      child.emit('spawn')
      if (binary === 'whisper-cli' && !options.holdWhisper) child.emit('close', options.whisperExit || 0)
    })
    return child
  }
  const files = {
    access: async () => { if (options.noModel) throw new Error('ENOENT') },
    mkdtemp: async () => '/private/session',
    rm: async path => removed.push(path),
    writeFile: async (...args) => writes.push(args),
    readFile: async () => ' hello world \n',
  }
  const helper = createLinuxDictation({ emit: message => messages.push(message), spawn, files,
    env: options.env || {}, executable: async name => name.includes('/') || options.missing?.includes(name) ? null : name,
    ...options })
  return { ...helper, messages, calls, removed, writes }
}

test('records PCM, emits RMS and transcribes a private WAV', async () => {
  const f = fixture({ env: { PICO_DICTATION_SOURCE: 'mic', PICO_WHISPER_LANGUAGE: 'fr' } })
  await f.handle({ id: 1, op: 'start' })
  assert.deepEqual(f.messages, [{ id: 1 }])
  assert.deepEqual(f.calls[0].args, ['--raw', '--format', 's16', '--rate', '16000', '--channels', '1', '--target', 'mic', '-'])
  f.calls[0].child.stdout.write(Buffer.from([0, 64, 0, 64]))
  assert.equal(f.messages[1].level, 0.5)
  await f.handle({ id: 2, op: 'stop' })
  assert.deepEqual(f.messages.at(-1), { id: 2, text: 'hello world' })
  assert.equal(f.writes[0][1].toString('ascii', 0, 4), 'RIFF')
  assert.equal(f.writes[0][1].readUInt32LE(40), 4)
  assert.equal(f.writes[0][2].mode, 0o600)
  assert.deepEqual(f.calls[1].args.slice(-3), ['-l', 'fr', '-nt'])
  assert.deepEqual(f.removed, ['/private/session'])
  await f.dispose()
})

test('uses parec only when pw-record is unavailable', async () => {
  const f = fixture({ missing: ['pw-record'], env: { PICO_DICTATION_SOURCE: 'source' } })
  await f.handle({ id: 1, op: 'start' })
  assert.equal(f.calls[0].binary, 'parec')
  assert.deepEqual(f.calls[0].args, ['--raw', '--format=s16le', '--rate=16000', '--channels=1', '--device', 'source'])
  await f.handle({ id: 2, op: 'cancel' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].child.killed, 'SIGTERM')
  assert.deepEqual(f.removed, ['/private/session'])
})

for (const [name, options, match] of [
  ['missing whisper', { missing: ['whisper-cli'] }, /PICO_WHISPER_BIN/],
  ['missing model', { noModel: true }, /PICO_WHISPER_MODEL/],
  ['missing recorder', { missing: ['pw-record', 'parec'] }, /PipeWire/],
]) test(name + ' provides setup guidance without downloading', async () => {
  const f = fixture(options)
  await f.handle({ id: 1, op: 'start' })
  assert.match(f.messages[0].error, match)
  assert.equal(f.calls.length, 0)
})

test('transcriber failure returns a request error and removes temporary files', async () => {
  const f = fixture({ whisperExit: 1 })
  await f.handle({ id: 1, op: 'start' })
  await f.handle({ id: 2, op: 'stop' })
  assert.match(f.messages.at(-1).error, /Whisper transcription failed/)
  assert.equal(f.removed.length, 1)
})

test('recorder spawn errors return a request error and clean up', async () => {
  const f = fixture({ spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => {}
    queueMicrotask(() => child.emit('error', new Error('microphone unavailable')))
    return child
  } })
  await f.handle({ id: 1, op: 'start' })
  assert.match(f.messages.at(-1).error, /microphone unavailable/)
  assert.equal(f.removed.length, 1)
})

test('unexpected microphone exit emits an unsolicited error', async () => {
  const f = fixture()
  await f.handle({ id: 1, op: 'start' })
  f.calls[0].child.emit('close', 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.messages.at(-1).status, 'error')
  assert.equal(f.removed.length, 1)
})

test('recording limit kills recorder and cleans up', async () => {
  const f = fixture({ maxRecordingMs: 5 })
  await f.handle({ id: 1, op: 'start' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.messages.at(-1).status, 'error')
  assert.equal(f.calls[0].child.killed, 'SIGTERM')
  assert.equal(f.removed.length, 1)
})

test('dispose interrupts an in-flight transcriber', async () => {
  const f = fixture({ holdWhisper: true })
  await f.handle({ id: 1, op: 'start' })
  const stopping = f.handle({ id: 2, op: 'stop' })
  await new Promise(resolve => setImmediate(resolve))
  await f.dispose()
  await stopping
  assert.equal(f.calls[1].child.killed, 'SIGTERM')
  assert.equal(f.messages.some(message => message.id === 2), false)
})

test('protocol emits ready and handles stdin closure and signals', async () => {
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter()
  let text = ''
  output.on('data', chunk => { text += chunk })
  const helper = runLinuxDictation({ input, output, signals })
  input.write('{"id":7,"op":"unknown"}\n')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(text.trim().split('\n').map(JSON.parse), [
    { status: 'ready' }, { id: 7, error: 'Unknown dictation command.' },
  ])
  signals.emit('SIGTERM')
  await helper.dispose()
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})

test('WAV header describes signed16 mono 16k PCM', () => {
  const header = wavHeader(32000)
  assert.equal(header.length, 44)
  assert.equal(header.readUInt32LE(24), 16000)
  assert.equal(header.readUInt16LE(22), 1)
  assert.equal(header.readUInt16LE(34), 16)
})
