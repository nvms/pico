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

test('compact eligibility is independent of size', () => {
  assert.equal(deriveState(eventsFor({ description: 'check status' }, 'ok')).transcript[0].contextCanTrim, true)
  const base = eventsFor({ content: 'x'.repeat(30000) }, 'y'.repeat(30000))
  assert.equal(deriveState(base).transcript[0].contextCanTrim, true)
  assert.equal(deriveState([...base, makeEvent('tool_trim', { callIds: ['c1'] })]).transcript[0].contextCanTrim, false)
  assert.equal(deriveState([...base, makeEvent('compact', { summary: 'done' })]).transcript[0].contextCanTrim, false)
})

test('already elided results can still be compacted', () => {
  const events = [...eventsFor({}, 'x'.repeat(30000)),
    makeEvent('message', { message: { role: 'user', content: 'next' } }),
    makeEvent('message', { message: { role: 'user', content: 'again' } })]
  assert.equal(deriveState(events).transcript[0].contextCanTrim, true)
})


test('whole-block compaction removes every result regardless of size and restores originals', () => {
  const events = []
  const callIds = []
  for (let i = 0; i < 50; i++) {
    const id = `call-${i}`
    callIds.push(id)
    const pair = eventsFor({ description: `inspect file ${i}`, path: `/file-${i}` }, 'x'.repeat(i ? 1800 : 2))
    pair[0].data.message.tool_calls[0].id = id
    pair[1].data.message.tool_call_id = id
    events.push(...pair)
  }
  const original = deriveState(events)
  const compact = makeEvent('tool_trim', { callIds, version: { algorithm: 'tool-compact-v2' } })
  const compacted = deriveState([...events, compact])
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(JSON.parse(compacted.providerHistory[i * 2].tool_calls[0].function.arguments), { description: `inspect file ${i}` })
    assert.match(compacted.providerHistory[i * 2 + 1].content, /compacted; retrieve with tool_result/)
    assert.equal(compacted.transcript[i].contextTrimmed, true)
    assert.equal(compacted.transcript[i].fullOutput, original.transcript[i].fullOutput)
  }
  const count = (state) => state.transcript.reduce((sum, item) => sum + item.contextTokens, 0)
  assert.ok(count(compacted) < count(original) / 4)
  assert.deepEqual(deriveState([...events, compact, makeEvent('tool_restore', { callIds })]).providerHistory, original.providerHistory)
  assert.deepEqual(deriveState(JSON.parse(JSON.stringify([...events, compact]))).providerHistory, compacted.providerHistory)
})


test('compacted results carry stable retrieval references and originals remain retrievable', async () => {
  const { retrieveToolResult } = await import('../src/tool-trimming.js')
  const base = eventsFor({ description: 'inspect', path: '/original' }, 'original output')
  const compact = makeEvent('tool_trim', { callIds: ['c1'], version: { algorithm: 'tool-compact-v2' } })
  const events = [...base, compact]
  assert.equal(deriveState(events).providerHistory[1].content, '[compacted; retrieve with tool_result({"id":"t1"})]')
  assert.deepEqual(retrieveToolResult(events, 't1'), {
    callId: 'c1', name: 'write', arguments: JSON.stringify({ description: 'inspect', path: '/original' }), result: 'original output',
  })
  assert.deepEqual(retrieveToolResult(JSON.parse(JSON.stringify(events)), 't1'), retrieveToolResult(events, 't1'))
  assert.deepEqual(retrieveToolResult([...events, makeEvent('clear', {})], 't1'), retrieveToolResult(events, 't1'))
  assert.throws(() => retrieveToolResult([], 't1'), /no saved tool result/)
})

test('retrieval tool returns original data without executing the original tool', async () => {
  const { createToolset } = await import('../src/tools/index.js')
  const { tools } = createToolset({ cwd: '/tmp', toolResult: (id) => ({ id, result: 'saved' }) })
  const tool = tools.find((tool) => tool.name === 'tool_result')
  assert.deepEqual(await tool.execute({ id: 't42', description: 'Retrieving original output' }), { id: 't42', result: 'saved' })
})

test('failed compacted calls preserve errors beside the retrieval reference', () => {
  const events = eventsFor({ description: 'write file' }, 'permission denied')
  events.push(makeEvent('tool_meta', { callId: 'c1', name: 'write', status: 'error', error: 'permission denied' }))
  events.push(makeEvent('tool_trim', { callIds: ['c1'], version: { algorithm: 'tool-compact-v2' } }))
  assert.match(deriveState(events).providerHistory[1].content, /^error: permission denied\n\[compacted;/)
})
