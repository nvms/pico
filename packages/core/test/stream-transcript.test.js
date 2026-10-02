import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamTranscript } from '../src/stream-transcript.js'

test('a growing response precedes incoming messages without mutating live state', () => {
  const items = [{ kind: 'tool' }, { kind: 'peer', messageId: 'p1', streamPending: true }, { kind: 'peer', messageId: 'p2', streamPending: true }]
  const first = streamTranscript(items, 'hello')
  const next = streamTranscript(items, 'hello world')
  assert.deepEqual(next.map(item => item.kind), ['tool', 'assistant', 'peer', 'peer'])
  assert.equal(first[1].text, 'hello')
  assert.equal(next[1].text, 'hello world')
  assert.equal(items[1].streamPending, true)
  assert.equal(next.some(item => 'streamPending' in item), false)
})

test('subsequent responses follow messages after the prior stream is finalized', () => {
  const finalized = streamTranscript([{ kind: 'peer', streamPending: true }], 'first response')
  finalized.push({ kind: 'tool' })
  const next = streamTranscript(finalized, 'next response')
  assert.deepEqual(next.map(item => item.kind), ['assistant', 'peer', 'tool', 'assistant'])
})

test('empty streams do not create empty assistant blocks', () => {
  assert.deepEqual(streamTranscript([{ kind: 'peer', streamPending: true }], null), [{ kind: 'peer' }])
})
