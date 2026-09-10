import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEvent } from '../src/events.js'
import { deriveState } from '../src/derive.js'
import { applyToolTrims } from '../src/tool-trimming.js'

const call = (id, args) => ({ id, type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } })
const eventsFor = (args, result) => [
  makeEvent('message', { message: { role: 'assistant', content: '', tool_calls: [call('c1', args)] } }),
  makeEvent('message', { message: { role: 'tool', tool_call_id: 'c1', content: result } }),
]

test('trim events alter provider history without altering transcript originals', () => {
  const original = 'a'.repeat(20000)
  const state = deriveState([...eventsFor({ description: 'write file', content: original }, original), makeEvent('tool_trim', { callIds: ['c1'] })])
  const tool = state.transcript[0]
  assert.equal(tool.args.content, original)
  assert.equal(tool.resultText, original)
  assert.equal(tool.contextTrimmed, true)
  assert.equal(tool.contextAvailable, true)
  assert.ok(tool.contextTokens > 0)
  assert.ok(state.providerHistory[0].tool_calls[0].function.arguments.length < original.length)
  assert.ok(state.providerHistory[1].content.length < original.length)
  assert.match(state.providerHistory[0].tool_calls[0].function.arguments, /write file/)
})

test('restore reverses a trim deterministically', () => {
  const base = eventsFor({ content: 'x'.repeat(20000) }, 'y'.repeat(20000))
  const trimmed = deriveState([...base, makeEvent('tool_trim', { callIds: ['c1'] })])
  const restored = deriveState([...base, makeEvent('tool_trim', { callIds: ['c1'] }), makeEvent('tool_restore', { callIds: ['c1'] })])
  assert.notDeepEqual(trimmed.providerHistory, restored.providerHistory)
  assert.deepEqual(restored.providerHistory, deriveState(base).providerHistory)
  assert.equal(restored.transcript[0].contextTrimmed, false)
})

test('trim preserves pairing and valid argument objects with multiple calls', () => {
  const history = [
    { role: 'assistant', tool_calls: [call('c1', { content: 'a'.repeat(20000) }), call('c2', { path: 'small' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'one'.repeat(10000) },
    { role: 'tool', tool_call_id: 'c2', content: 'two' },
  ]
  const transformed = applyToolTrims(history, new Set(['c1']))
  assert.doesNotThrow(() => JSON.parse(transformed[0].tool_calls[0].function.arguments))
  assert.deepEqual(transformed[0].tool_calls[1], history[0].tool_calls[1])
  assert.equal(transformed[1].tool_call_id, 'c1')
  assert.strictEqual(transformed[2], history[2])
})

test('trim replaces image parts without mutating their structure', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'z'.repeat(30000) } }
  const history = [
    { role: 'assistant', tool_calls: [call('c1', {})] },
    { role: 'tool', tool_call_id: 'c1', content: [image, { type: 'text', text: 'visible' }] },
  ]
  const transformed = applyToolTrims(history, new Set(['c1']))
  assert.deepEqual(history[1].content[0], image)
  assert.deepEqual(transformed[1].content[0], { type: 'text', text: '[tool image omitted to save context]' })
})

test('full compaction makes earlier tools unavailable and prevents restore effects', () => {
  const base = eventsFor({ content: 'x'.repeat(20000) }, 'y'.repeat(20000))
  const state = deriveState([
    ...base,
    makeEvent('tool_trim', { callIds: ['c1'] }),
    makeEvent('compact', { summary: 'summary' }),
    makeEvent('tool_restore', { callIds: ['c1'] }),
  ])
  assert.equal(state.transcript[0].contextAvailable, false)
  assert.equal(state.transcript[0].contextTrimmed, false)
  assert.equal(state.providerHistory.some((message) => message.tool_call_id === 'c1'), false)
})

test('clear resets trim state', () => {
  const state = deriveState([...eventsFor({}, 'result'), makeEvent('tool_trim', { callIds: ['c1'] }), makeEvent('clear', {})])
  assert.equal(state.trimmedToolIds.size, 0)
  assert.equal(state.transcript.length, 0)
})

test('token totals decrease after trimming and return on restore', () => {
  const base = eventsFor({ description: 'write file', content: 'x'.repeat(30000) }, 'y'.repeat(30000))
  const before = deriveState(base).transcript[0].contextTokens
  const trim = makeEvent('tool_trim', { callIds: ['c1'] })
  const after = deriveState([...base, trim]).transcript[0].contextTokens
  assert.ok(after < before)
  assert.equal(deriveState([...base, trim, makeEvent('tool_restore', { callIds: ['c1'] })]).transcript[0].contextTokens, before)
})

test('rewind and undo restore the effective trim state', () => {
  const base = eventsFor({ content: 'x'.repeat(30000) }, 'y'.repeat(30000))
  const trim = makeEvent('tool_trim', { callIds: ['c1'] })
  const rewind = makeEvent('rewind', { mode: 'chat', target: trim.id })
  assert.equal(deriveState([...base, trim, rewind]).transcript[0].contextTrimmed, false)
  const undo = makeEvent('rewind_undo', { rewindId: rewind.id })
  assert.equal(deriveState([...base, trim, rewind, undo]).transcript[0].contextTrimmed, true)
})

test('partial full compaction retains reversible trims only in the kept history', () => {
  const base = eventsFor({ content: 'x'.repeat(30000) }, 'y'.repeat(30000))
  const events = [...base, makeEvent('tool_trim', { callIds: ['c1'] }), makeEvent('compact', { summary: 'earlier', keepFrom: base[0].id })]
  const replay = deriveState(JSON.parse(JSON.stringify(events)))
  assert.equal(replay.transcript[0].contextTrimmed, true)
  const restored = deriveState([...events, makeEvent('tool_restore', { callIds: ['c1'] })])
  assert.equal(restored.providerHistory.at(-1).content, 'y'.repeat(30000))
})

test('escaped arguments remain bounded and preserve their description', () => {
  const base = eventsFor({ description: 'write file', content: '\"\\\n'.repeat(30000), other: 'x'.repeat(30000) }, 'ok')
  const state = deriveState([...base, makeEvent('tool_trim', { callIds: ['c1'] })])
  const args = state.providerHistory[0].tool_calls[0].function.arguments
  assert.ok(args.length <= 8000)
  assert.equal(JSON.parse(args).description, 'write file')
})
