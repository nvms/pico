import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentTranscript } from '../src/agent-transcript.js'

const deliberation = (extra) => ({
  role: 'deliberation',
  prompt: 'ship a settings window?',
  status: 'running',
  timeline: [{ kind: 'turn', value: { role: 'proposer', round: 1, text: 'yes, users expect one' } }],
  result: null,
  error: null,
  ...extra,
})

test('a speaking participant shows its streamed words on the open turn', () => {
  const items = agentTranscript(deliberation({ live: { role: 'reviewer', round: 1, text: 'every setting already lives in' } }))
  const turns = items.filter((i) => i.kind === 'deliberation-turn')
  assert.equal(turns.length, 2)
  assert.equal(turns[1].role, 'reviewer')
  assert.equal(turns[1].text, 'every setting already lives in')
  assert.equal(turns[1].active, true)
})

test('the settled turn text wins over a stale live buffer', () => {
  const items = agentTranscript(deliberation({ live: { role: 'proposer', round: 1, text: 'partial' } }))
  assert.equal(items.filter((i) => i.kind === 'deliberation-turn')[0].text, 'yes, users expect one')
})

test('the synthesizer streams as an active synthesis turn until the result lands', () => {
  const items = agentTranscript(deliberation({ live: { role: 'synthesis', round: null, text: 'on balance' } }))
  const last = items.at(-1)
  assert.deepEqual([last.role, last.text, last.active], ['synthesis', 'on balance', true])
  const done = agentTranscript(deliberation({ status: 'completed', result: 'no window', live: { role: 'synthesis', round: null, text: 'on balance' } }))
  assert.equal(done.at(-1).text, 'no window')
})
