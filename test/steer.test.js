import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveState } from '../src/core/derive.js'
import { applySteering, STEER_ROLES } from '../src/core/steer.js'

const event = (id, type, data = {}) => ({ id, at: 1, type, data })
const message = (id, role, content) => event(id, 'message', { message: { role, content } })

test('steering replaces a message in transcript and provider history', () => {
  const events = [
    message('u1', 'user', 'Do you like cats?'),
    message('a1', 'assistant', 'Yes.'),
    event('s1', 'steer', { changes: [{ op: 'replace', target: 'a1', message: { role: 'assistant', content: 'No, not at all.' } }] }),
  ]
  const state = deriveState(events)
  assert.deepEqual(state.providerHistory, [
    { role: 'user', content: 'Do you like cats?' },
    { role: 'assistant', content: 'No, not at all.' },
  ])
  assert.equal(state.transcript[1].text, 'No, not at all.')
  assert.equal(state.transcript[1].steered, true)
})

test('editing assistant text preserves its structured tool calls', () => {
  const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }]
  const events = [
    event('a1', 'message', { message: { role: 'assistant', content: 'Before', tool_calls: toolCalls } }),
    message('t1', 'tool', 'result'),
    event('s1', 'steer', { changes: [{ op: 'replace', target: 'a1', message: { role: 'assistant', content: 'After' } }] }),
  ]
  events[1].data.message.tool_call_id = 'call-1'
  const history = deriveState(events).providerHistory
  assert.deepEqual(history[0].tool_calls, toolCalls)
  assert.equal(history[0].content, 'After')
  assert.equal(history[1].tool_call_id, 'call-1')
})

test('steering inserts portable user and assistant messages in order', () => {
  const events = [
    message('u1', 'user', 'One'),
    event('s1', 'steer', { changes: [
      { op: 'insert', id: 'a1', after: 'u1', message: { role: 'assistant', content: 'Two' } },
      { op: 'insert', id: 'u2', after: 'a1', message: { role: 'user', content: 'Three' } },
    ] }),
  ]
  assert.deepEqual(deriveState(events).providerHistory, [
    { role: 'user', content: 'One' },
    { role: 'assistant', content: 'Two' },
    { role: 'user', content: 'Three' },
  ])
  assert.deepEqual(STEER_ROLES, ['user', 'assistant'])
})

test('inserting after an assistant tool call keeps its results contiguous', () => {
  const calls = [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }]
  const assistant = event('a1', 'message', { message: { role: 'assistant', content: 'Checking', tool_calls: calls } })
  const toolResult = event('t1', 'message', { message: { role: 'tool', content: 'result', tool_call_id: 'call-1' } })
  const events = [
    assistant,
    toolResult,
    event('s1', 'steer', { changes: [{ op: 'insert', id: 'u2', after: 'a1', message: { role: 'user', content: 'Continue' } }] }),
  ]
  assert.deepEqual(deriveState(events).providerHistory.map((message) => message.role), ['assistant', 'tool', 'user'])
})

test('messages before the latest compaction are locked and cannot be changed', () => {
  const events = [
    message('u1', 'user', 'Old'),
    message('a1', 'assistant', 'Old answer'),
    event('c1', 'compact', { summary: 'summary' }),
    message('u2', 'user', 'Current'),
    event('s1', 'steer', { changes: [
      { op: 'replace', target: 'a1', message: { role: 'assistant', content: 'Changed old answer' } },
      { op: 'replace', target: 'u2', message: { role: 'user', content: 'Changed current' } },
    ] }),
  ]
  const state = deriveState(events)
  assert.equal(state.transcript.find((item) => item.messageId === 'a1').text, 'Old answer')
  assert.equal(state.transcript.find((item) => item.messageId === 'a1').locked, true)
  assert.equal(state.transcript.find((item) => item.messageId === 'u2').text, 'Changed current')
  assert.equal(state.transcript.find((item) => item.messageId === 'u2').locked, false)
})

test('steering is append-only and does not mutate original events', () => {
  const original = message('a1', 'assistant', 'Original')
  const events = [original, event('s1', 'steer', { changes: [{ op: 'replace', target: 'a1', message: { role: 'assistant', content: 'Edited' } }] })]
  const effective = applySteering(events)
  assert.equal(original.data.message.content, 'Original')
  assert.equal(effective[0].data.message.content, 'Edited')
})
