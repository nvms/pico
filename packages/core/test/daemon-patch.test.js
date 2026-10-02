import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serialize } from 'node:v8'
import { diffSnapshot, applyPatches } from '../src/daemon-patch.js'

test('message additions and streaming exclude existing conversation history', () => {
  const previous = { state: { events: Array.from({ length: 500 }, (_, id) => ({ id, text: 'history'.repeat(1000) })), streaming: 'hello' } }
  const next = { state: { events: [...previous.state.events, { id: 501, text: 'new message' }], streaming: 'hello world' } }
  const patches = diffSnapshot(previous, next)
  assert.ok(serialize(patches).length < 1000)
  const applied = applyPatches(previous, patches)
  assert.deepEqual(applied, next)
  assert.equal(previous.state.events.length, 500)
  assert.notEqual(applied.state, previous.state)
  assert.notEqual(applied.state.events, previous.state.events)
  assert.equal(applied.state.events[0], previous.state.events[0])
})

test('rewinds, replacements, deleted keys and attachment maps reconstruct exactly', () => {
  const before = { events: [{ text: 'a' }, { text: 'b' }], flag: true, attachments: new Map([['image', 1]]) }
  const after = { events: [{ text: 'summary' }], attachments: new Map(), busy: false }
  assert.deepEqual(applyPatches(before, diffSnapshot(before, after)), after)
  assert.equal(before.events.length, 2)
})
