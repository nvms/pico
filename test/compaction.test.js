import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactionPrompt, formatCompactSummary, continuationMessage, summarySections } from '../src/core/compaction.js'
import { compactProgress } from '../src/core/agent.js'
import { deriveState } from '../src/core/derive.js'
import { makeEvent } from '../src/core/events.js'

const user = (text) => makeEvent('message', { message: { role: 'user', content: text } })
const assistant = (text) => makeEvent('message', { message: { role: 'assistant', content: text } })

test('compaction prompt includes structure and optional focus instructions', () => {
  const base = compactionPrompt()
  assert.match(base, /<analysis>/)
  assert.match(base, /All User Messages/)
  assert.match(base, /Next Step/)
  assert.doesNotMatch(base, /Additional instructions/)
  assert.match(compactionPrompt('focus on the API'), /Additional instructions:\nfocus on the API/)
})

test('formatCompactSummary strips analysis and unwraps summary', () => {
  const raw = '<analysis>\ndraft thoughts\n</analysis>\n\n<summary>\n1. Primary Request:\n   build the thing\n</summary>'
  const formatted = formatCompactSummary(raw)
  assert.doesNotMatch(formatted, /draft thoughts/)
  assert.match(formatted, /Primary Request/)
  assert.equal(formatCompactSummary('plain text summary'), 'plain text summary')
})

test('continuation message points at the session file and kept messages', () => {
  const text = continuationMessage('the summary', { sessionFile: '/x/session.jsonl', recentKept: true })
  assert.match(text, /the summary/)
  assert.match(text, /\/x\/session.jsonl/)
  assert.match(text, /most recent messages follow verbatim/)
  assert.match(text, /Do not recap/)
  const bare = continuationMessage('s', {})
  assert.doesNotMatch(bare, /session.jsonl/)
  assert.doesNotMatch(bare, /verbatim/)
})

test('partial compact keeps messages from keepFrom and prepends the summary', () => {
  const u1 = user('first question')
  const a1 = assistant('first answer')
  const u2 = user('second question')
  const a2 = assistant('second answer')
  const compact = makeEvent('compact', { summary: 'earlier stuff happened', keepFrom: u2.id, sessionFile: '/x/s.jsonl' })

  const state = deriveState([u1, a1, u2, a2, compact])
  assert.equal(state.providerHistory.length, 3)
  assert.match(state.providerHistory[0].content, /earlier stuff happened/)
  assert.match(state.providerHistory[0].content, /\/x\/s.jsonl/)
  assert.equal(state.providerHistory[1].content, 'second question')
  assert.equal(state.providerHistory[2].content, 'second answer')
  assert.equal(state.transcript.filter((i) => i.kind === 'summary').length, 1)
  assert.equal(state.transcript.filter((i) => i.kind === 'user').length, 2)
  assert.equal(state.lastPromptTokens, 0)

  const followUp = user('third question')
  const later = deriveState([u1, a1, u2, a2, compact, followUp])
  assert.equal(later.providerHistory.length, 4)
  assert.equal(later.providerHistory.at(-1).content, 'third question')
})

test('chained compacts each keep their own recent window', () => {
  const u1 = user('one')
  const u2 = user('two')
  const first = makeEvent('compact', { summary: 's1', keepFrom: u2.id, sessionFile: '/x.jsonl' })
  const u3 = user('three')
  const second = makeEvent('compact', { summary: 's2', keepFrom: u2.id, sessionFile: '/x.jsonl' })
  const events = [u1, assistant('a1'), u2, assistant('a2'), first, u3, assistant('a3'), second]

  const state = deriveState(events)
  assert.match(state.providerHistory[0].content, /s2/)
  assert.equal(state.providerHistory[1].content, 'two')
  assert.equal(state.providerHistory.at(-1).content, 'a3')
  assert.equal(state.transcript.filter((i) => i.kind === 'summary').length, 2)
  assert.equal(state.transcript.filter((i) => i.kind === 'user').length, 3)
})

test('stale keepFrom degrades to a summary-only compact', () => {
  const u1 = user('one')
  const u2 = user('two')
  const events = [
    u1,
    assistant('a1'),
    u2,
    assistant('a2'),
    makeEvent('compact', { summary: 's1', keepFrom: u2.id, sessionFile: '/x.jsonl' }),
    makeEvent('compact', { summary: 's2', keepFrom: u1.id, sessionFile: '/x.jsonl' }),
  ]
  const state = deriveState(events)
  assert.equal(state.providerHistory.length, 1)
  assert.match(state.providerHistory[0].content, /s2/)
})

test('formatCompactSummary salvages malformed model output', () => {
  const unclosedBoth = '<analysis>\nrambling draft\nmore rambling\n1. Primary Request:\n   the thing\n2. Key Concepts:\n   stuff'
  const salvaged = formatCompactSummary(unclosedBoth)
  assert.doesNotMatch(salvaged, /rambling/)
  assert.match(salvaged, /Primary Request/)

  const unclosedSummary = '<analysis>\ndraft\n</analysis>\n<summary>\n1. Primary Request:\n   cut off mid-stream'
  assert.match(formatCompactSummary(unclosedSummary), /Primary Request/)
  assert.doesNotMatch(formatCompactSummary(unclosedSummary), /draft/)

  assert.equal(formatCompactSummary('<analysis>\nonly rambling, no sections'), '')
})

test('summarySections counts top-level headers only', () => {
  const good = ['1. A', 'text', '2. B', '  1. indented sub-item', '3. C', '4. D', '5. E'].join('\n')
  assert.equal(summarySections(good), 5)
  assert.equal(summarySections('prose with no structure'), 0)
})

test('compactProgress tracks analysis then numbered sections', () => {
  assert.deepEqual(compactProgress('<analysis>\nthinking'), { phase: 'analyzing', section: 0, chars: 19 })
  const two = '<analysis>\n1. fake list inside analysis\n</analysis>\n<summary>\n1. Primary Request:\n   stuff\n2. Key Concepts:\n'
  assert.equal(compactProgress(two).phase, 'writing')
  assert.equal(compactProgress(two).section, 2)
  const noAnalysis = '<summary>\n1. Primary Request:\n'
  assert.equal(compactProgress(noAnalysis).section, 1)
  const many = '</analysis>\n' + Array.from({ length: 12 }, (_, i) => `${i + 1}. Section`).join('\n')
  assert.equal(compactProgress(many).section, 8)
})

test('legacy compact events without keepFrom still fold the old way', () => {
  const events = [user('a'), assistant('b'), makeEvent('compact', { summary: 'old style' }), user('c')]
  const state = deriveState(events)
  assert.equal(state.providerHistory.length, 3)
  assert.match(state.providerHistory[0].content, /old style/)
  assert.equal(state.providerHistory[1].role, 'assistant')
})
