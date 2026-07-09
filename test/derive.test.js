import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEvent } from '../src/core/events.js'
import { deriveState, userEntries, rewindStats } from '../src/core/derive.js'

const user = (text) => makeEvent('message', { message: { role: 'user', content: text } })
const assistant = (content, toolCalls) =>
  makeEvent('message', {
    message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
  })
const toolResult = (id, content) =>
  makeEvent('message', { message: { role: 'tool', tool_call_id: id, content } })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('folds a plain conversation', () => {
  const events = [user('hi'), assistant('hello there')]
  const state = deriveState(events)
  assert.equal(state.transcript.length, 2)
  assert.equal(state.transcript[0].kind, 'user')
  assert.equal(state.transcript[1].kind, 'assistant')
  assert.equal(state.providerHistory.length, 2)
})

test('folds tool calls with meta', () => {
  const events = [
    user('edit the file'),
    assistant('', [call('c1', 'edit', { path: 'a.js' })]),
    toolResult('c1', '{"ok":true}'),
    makeEvent('tool_meta', { callId: 'c1', title: 'a.js', status: 'done', durationMs: 12, diff: { hunks: [] } }),
    assistant('done'),
  ]
  const state = deriveState(events)
  const tool = state.transcript.find((i) => i.kind === 'tool')
  assert.equal(tool.title, 'a.js')
  assert.equal(tool.resultText, '{"ok":true}')
  assert.ok(tool.diff)
  assert.equal(state.providerHistory.length, 4)
})

test('rewind chat mode drops the tail, undo restores it', () => {
  const target = user('second question')
  const events = [
    user('first'),
    assistant('answer one'),
    target,
    assistant('answer two'),
  ]
  const rewind = makeEvent('rewind', { target: target.id, mode: 'chat' })
  let state = deriveState([...events, rewind])
  assert.equal(state.transcript.length, 2)
  assert.equal(state.providerHistory.length, 2)

  const undo = makeEvent('rewind_undo', { rewindId: rewind.id })
  state = deriveState([...events, rewind, undo])
  assert.equal(state.transcript.length, 4)
})

test('rewind summary mode appends a summary', () => {
  const target = user('second')
  const events = [user('first'), assistant('one'), target, assistant('two')]
  const rewind = makeEvent('rewind', { target: target.id, mode: 'summary', summaryText: 'talked about one' })
  const state = deriveState([...events, rewind])
  assert.equal(state.transcript.at(-1).kind, 'summary')
  assert.equal(state.providerHistory.at(-1).role, 'assistant')
  assert.match(state.providerHistory.at(-1).content, /talked about one/)
})

test('rewind code mode keeps transcript, marks reverted', () => {
  const events = [
    user('edit'),
    assistant('', [call('c1', 'edit', { path: 'a.js' })]),
    toolResult('c1', '{}'),
    makeEvent('tool_meta', { callId: 'c1', status: 'done', revert: { path: 'a.js', before: 'x', after: 'y' } }),
    assistant('done'),
  ]
  const rewind = makeEvent('rewind', { target: events[0].id, mode: 'code', reverted: ['c1'] })
  const state = deriveState([...events, rewind])
  assert.equal(state.transcript.length, 3)
  assert.equal(state.transcript.find((i) => i.kind === 'tool').status, 'reverted')
})

test('compact resets provider history but keeps transcript', () => {
  const events = [
    user('a'),
    assistant('b'),
    makeEvent('compact', { summary: 'we discussed a' }),
    user('c'),
    assistant('d'),
  ]
  const state = deriveState(events)
  assert.equal(state.providerHistory.length, 4)
  assert.match(state.providerHistory[0].content, /we discussed a/)
  assert.equal(state.transcript.filter((i) => i.kind === 'summary').length, 1)
  assert.equal(state.transcript.length, 5)
})

test('clear resets everything visible', () => {
  const events = [user('a'), assistant('b'), makeEvent('clear', {}), user('c')]
  const state = deriveState(events)
  assert.equal(state.transcript.length, 1)
  assert.equal(state.providerHistory.length, 1)
})

test('spent usage survives rewinds, active usage rolls back', () => {
  const target = user('q2')
  const usage1 = makeEvent('usage', { model: 'google/gemini-2.5-pro', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0 } })
  const usage2 = makeEvent('usage', { model: 'google/gemini-2.5-pro', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cachedTokens: 0 } })
  const events = [user('q1'), usage1, assistant('a1'), target, usage2, assistant('a2')]
  const rewind = makeEvent('rewind', { target: target.id, mode: 'chat' })
  const state = deriveState([...events, rewind])
  assert.equal(state.usage.promptTokens, 30)
  assert.equal(state.usage.completionTokens, 15)
  assert.equal(state.usageActive.promptTokens, 10)
  assert.equal(state.usageActive.completionTokens, 5)
  assert.equal(state.usageActiveByModel['google/gemini-2.5-pro'].promptTokens, 10)

  const undo = makeEvent('rewind_undo', { rewindId: rewind.id })
  const restored = deriveState([...events, rewind, undo])
  assert.equal(restored.usageActive.promptTokens, 30)
})

test('effort events track session effort, absent means unset', () => {
  assert.equal(deriveState([user('hi')]).effort, undefined)
  const set = deriveState([user('hi'), makeEvent('effort', { to: 'high' })])
  assert.equal(set.effort, 'high')
  const reset = deriveState([user('hi'), makeEvent('effort', { to: 'high' }), makeEvent('effort', { to: null })])
  assert.equal(reset.effort, null)
})

test('title and color events stick, latest wins', () => {
  const state = deriveState([
    user('hi'),
    makeEvent('title', { text: 'first name' }),
    makeEvent('color', { value: '#60a5fa' }),
    makeEvent('title', { text: 'vets' }),
  ])
  assert.equal(state.title, 'vets')
  assert.equal(state.color, '#60a5fa')
})

test('model_switch tracks current model', () => {
  const events = [
    makeEvent('model_switch', { from: null, to: 'google/gemini-2.5-pro' }),
    user('hi'),
    makeEvent('model_switch', { from: 'google/gemini-2.5-pro', to: 'google/gemini-2.5-flash' }),
  ]
  assert.equal(deriveState(events).model, 'google/gemini-2.5-flash')
})

test('userEntries and rewindStats', () => {
  const first = user('one')
  const events = [
    first,
    assistant('', [call('c1', 'edit', {})]),
    toolResult('c1', '{}'),
    makeEvent('tool_meta', { callId: 'c1', status: 'done', revert: { path: 'x', before: '', after: '' } }),
    assistant('ok'),
  ]
  const state = deriveState(events)
  const entries = userEntries(state)
  assert.equal(entries.length, 1)
  const stats = rewindStats(state, entries[0].index)
  assert.equal(stats.msgs, 3)
  assert.equal(stats.edits.length, 1)
})
