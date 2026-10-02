import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serialize } from 'node:v8'
import { snapshot, createDaemonRuntime } from '../src/daemon-runtime.js'
import { diffSnapshot, applyPatches } from '../src/daemon-patch.js'

function controller(count = 1000) {
  const listeners = new Map()
  return {
    boot: {},
    state: { events: Array.from({ length: count }, () => ({ text: 'raw'.repeat(1000) })), derived: { title: 'named', providerHistory: ['private'], transcript: Array.from({ length: count }, (_, id) => ({ kind: 'assistant', id, text: `message ${id}` })) }, overlay: [{ text: 'hello' }], streaming: { text: 'hello' }, attachments: new Map(), rewindUndo: { events: ['private'] } },
    on(type, fn) { listeners.set(type, fn); return () => listeners.delete(type) },
    emit() { listeners.get('change')?.() },
    async shutdown() {},
  }
}

test('snapshot omits backend history and limits transcript independently of event count', () => {
  const ctl = controller()
  const first = snapshot(ctl)
  assert.equal(first.state.derived.transcript.length, 100)
  assert.equal(first.state.derived.transcriptOffset, 900)
  assert.equal(first.state.derived.transcriptTotal, 1000)
  assert.equal(first.state.events, undefined)
  assert.equal(first.state.derived.providerHistory, undefined)
  assert.equal(first.state.rewindUndo, true)
  const size = serialize(first).length
  ctl.state.events.push(...Array.from({ length: 10000 }, () => ({ text: 'raw'.repeat(1000) })))
  assert.equal(serialize(snapshot(ctl)).length, size)
})

test('streaming clones mutable overlays but never revisits cached transcript items', () => {
  const ctl = controller()
  const first = snapshot(ctl)
  for (const item of ctl.state.derived.transcript) Object.defineProperty(item, 'text', { enumerable: true, get() { throw new Error('historical item visited') } })
  ctl.state.overlay[0].text += ' world'
  ctl.state.streaming.text += ' world'
  const next = snapshot(ctl)
  assert.equal(first.state.streaming.text, 'hello')
  assert.equal(first.state.overlay[0].text, 'hello')
  assert.equal(first.state.derived.transcript, next.state.derived.transcript)
  assert.deepEqual(applyPatches(first, diffSnapshot(first, next)), next)
  assert.ok(serialize(diffSnapshot(first, next)).length < 500)
})

test('history expands only its client view and subsequent patches retain sequence correctness', async () => {
  const ctl = controller(250)
  const runtime = createDaemonRuntime({ createSession: async () => ctl, batchMs: 1 })
  const messages = []
  const a = { send: message => messages.push(message) }
  const bMessages = []
  const b = { send: message => bMessages.push(message) }
  const created = await runtime.dispatch(a, { op: 'create' })
  const attached = await runtime.dispatch(b, { op: 'attach', id: created.id })
  const expanded = await runtime.dispatch(a, { op: 'history', id: created.id, args: [200] })
  assert.equal(expanded.sequence, created.sequence + 1)
  assert.equal(expanded.snapshot.state.derived.transcriptOffset, 50)
  await assert.rejects(runtime.dispatch(a, { op: 'history', id: created.id, args: [-1] }))
  ctl.state.derived = { ...ctl.state.derived, transcript: [...ctl.state.derived.transcript, { id: 250, text: 'new' }] }
  ctl.state.streaming.text += '!'
  ctl.emit()
  await new Promise(resolve => setTimeout(resolve, 20))
  const update = messages.find(message => message.type === 'update')
  const other = bMessages.find(message => message.type === 'update')
  assert.equal(update.baseSequence, expanded.sequence)
  assert.equal(update.sequence, expanded.sequence + 1)
  assert.equal(other.baseSequence, attached.sequence)
  assert.deepEqual(applyPatches(expanded.snapshot, update.patches), snapshot(ctl, 200))
  assert.deepEqual(applyPatches(attached.snapshot, other.patches), snapshot(ctl, 100))
  assert.equal((await runtime.dispatch(a, { op: 'snapshot', id: created.id })).snapshot.state.derived.transcript.length, 200)
  await runtime.close()
})
