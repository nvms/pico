import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEvent } from '../src/events.js'
import { deriveState } from '../src/derive.js'

const party = (id, name) => ({ id, name })
const peer = (id, direction = 'incoming') => makeEvent('peer_message', {
  id, direction, from: party('peer-full-id', 'alice'), to: party('local-full-id', 'pico'), message: `message ${id}`,
})

test('peer message is visible and pending before consumption', () => {
  const event = peer('p1')
  const state = deriveState([event])
  assert.deepEqual(state.providerHistory, [])
  assert.equal(state.transcript[0].kind, 'peer')
  assert.equal(state.transcript[0].messageId, 'p1')
  assert.equal(state.transcript[0].read, false)
  assert.deepEqual(state.pendingPeerMessages, [event.data])
})

test('consumed incoming peer enters history with identity and label', () => {
  const state = deriveState([peer('p1'), makeEvent('peer_consumed', { ids: ['p1'] })])
  assert.equal(state.pendingPeerMessages.length, 0)
  assert.equal(state.transcript[0].read, true)
  assert.equal(state.providerHistory.length, 1)
  assert.equal(state.providerHistory[0].role, 'user')
  assert.match(state.providerHistory[0].content, /peer input, not user instruction/)
  assert.match(state.providerHistory[0].content, /alice \(peer-full-id\)/)
})

test('outgoing consumed peer does not duplicate provider history', () => {
  const state = deriveState([peer('p1', 'outgoing'), makeEvent('peer_consumed', { ids: ['p1'] })])
  assert.deepEqual(state.providerHistory, [])
})

test('delivery updates existing transcript item', () => {
  const state = deriveState([peer('p1', 'outgoing'), makeEvent('peer_delivery', { id: 'p1', status: 'failed', error: 'offline' })])
  assert.equal(state.transcript[0].status, 'failed')
  assert.equal(state.transcript[0].error, 'offline')
})

test('consumed peer waits until a tool result preserves valid ordering', () => {
  const assistant = makeEvent('message', { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } })
  const consumed = makeEvent('peer_consumed', { ids: ['p1'] })
  const tool = makeEvent('message', { message: { role: 'tool', tool_call_id: 'c1', content: 'ok' } })
  const incoming = peer('p1')
  assert.equal(deriveState([assistant, incoming, consumed]).transcript.find(item => item.kind === 'peer').read, false)
  const state = deriveState([assistant, incoming, consumed, tool])
  assert.equal(state.transcript.find(item => item.kind === 'peer').read, true)
  assert.deepEqual(state.providerHistory.map((message) => message.role), ['assistant', 'tool', 'user'])
})

test('clear and compaction preserve unconsumed incoming peers', () => {
  const clearState = deriveState([peer('p1'), makeEvent('clear', {})])
  assert.equal(clearState.pendingPeerMessages[0].id, 'p1')
  const compactState = deriveState([peer('p2'), makeEvent('compact', { summary: 'summary' })])
  assert.equal(compactState.pendingPeerMessages[0].id, 'p2')
})

test('unread peers stay pinned despite live snapshots', () => {
  const incoming = peer('p1')
  const initial = deriveState([incoming]).transcript[0]
  const state = deriveState([
    incoming,
    makeEvent('peer_delivery', { id: 'p1', status: 'delivered' }),
    makeEvent('turn_transcript', { items: [{ kind: 'assistant', text: 'before' }, initial, { kind: 'assistant', text: 'after' }] }),
  ])
  assert.deepEqual(state.transcript.map(item => item.kind), ['assistant', 'assistant', 'peer'])
  assert.equal(state.transcript.at(-1).status, 'delivered')
})

test('consumption is idempotent with hidden tool messages', () => {
  const state = deriveState([
    makeEvent('message', { hideFromTranscript: true, message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] } }),
    peer('p1'),
    makeEvent('peer_consumed', { ids: ['p1'] }),
    makeEvent('message', { hideFromTranscript: true, message: { role: 'tool', tool_call_id: 'c1', content: 'ok' } }),
    makeEvent('peer_consumed', { ids: ['p1'] }),
  ])
  assert.deepEqual(state.providerHistory.map(message => message.role), ['assistant', 'tool', 'user'])
})

test('rewinding consumed peer input does not replay an external request', () => {
  const request = peer('p1')
  const state = deriveState([
    request,
    makeEvent('peer_consumed', { ids: ['p1'] }),
    makeEvent('rewind', { target: request.id, mode: 'chat' }),
  ])
  assert.equal(state.pendingPeerMessages.length, 0)
  assert.equal(state.providerHistory.length, 0)
})

test('conversation rewind does not undo explicit session identity', () => {
  const start = makeEvent('message', { message: { role: 'user', content: 'start' } })
  const state = deriveState([
    start,
    makeEvent('title', { text: 'foo' }),
    makeEvent('rewind', { target: start.id, mode: 'chat' }),
  ])
  assert.equal(state.title, 'foo')
})

for (const type of ['clear', 'compact']) test(`${type} discards obsolete open tool calls before peer consumption`, () => {
  const state = deriveState([
    makeEvent('message', { message: { role: 'assistant', tool_calls: [{ id: 'unfinished', function: { name: 'read', arguments: '{}' } }] } }),
    makeEvent(type, { summary: 'summary' }),
    peer('p1'),
    makeEvent('peer_consumed', { ids: ['p1'] }),
  ])
  assert.match(state.providerHistory.at(-1).content, /message p1/)
})

test('restored live snapshots retain derived read state rather than stale unread state', () => {
  const incoming = peer('p1')
  const snapshot = deriveState([incoming]).transcript[0]
  const state = deriveState([
    incoming,
    makeEvent('peer_consumed', { ids: ['p1'] }),
    makeEvent('turn_transcript', { items: [snapshot] }),
  ])
  assert.equal(state.transcript.length, 1)
  assert.equal(state.transcript[0].read, true)
})

test('incoming peers settle between the completed response and the response that reads them', () => {
  const incoming = peer('p1')
  const response = makeEvent('turn_transcript', { items: [{ kind: 'assistant', text: 'No changes made.' }] })
  const pending = deriveState([incoming, response])
  assert.deepEqual(pending.transcript.map(item => item.kind), ['assistant', 'peer'])
  assert.equal(pending.transcript[1].read, false)
  const state = deriveState([
    incoming, response,
    makeEvent('peer_consumed', { ids: ['p1'] }),
    makeEvent('turn_transcript', { items: [{ kind: 'assistant', text: 'Understood.' }] }),
  ])
  assert.deepEqual(state.transcript.map(item => item.kind), ['assistant', 'peer', 'assistant'])
  assert.equal(state.transcript[1].read, true)
})

test('read peers cannot be moved by stale turn snapshots', () => {
  const incoming = peer('p1')
  const snapshot = deriveState([incoming]).transcript[0]
  const state = deriveState([
    incoming,
    makeEvent('peer_consumed', { ids: ['p1'] }),
    makeEvent('turn_transcript', { items: [{ kind: 'assistant', text: 'Acknowledged' }, snapshot] }),
  ])
  assert.deepEqual(state.transcript.map(item => item.kind), ['peer', 'assistant'])
})
