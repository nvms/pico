import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactionPrompt, formatCompactSummary, continuationMessage } from '../src/core/compaction.js'
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

test('legacy compact events without keepFrom still fold the old way', () => {
  const events = [user('a'), assistant('b'), makeEvent('compact', { summary: 'old style' }), user('c')]
  const state = deriveState(events)
  assert.equal(state.providerHistory.length, 3)
  assert.match(state.providerHistory[0].content, /old style/)
  assert.equal(state.providerHistory[1].role, 'assistant')
})
