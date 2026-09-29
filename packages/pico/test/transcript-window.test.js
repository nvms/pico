import assert from 'node:assert/strict'
import test from 'node:test'
import { compactTranscriptRuns, transcriptWindow } from '../src/ui/transcript-window.js'

const tool = (callId) => ({ kind: 'tool', callId, name: 'read' })
const message = (messageId) => ({ kind: 'assistant', messageId })

test('paginates compact tool runs as single items', () => {
  const source = [message('before'), ...Array.from({ length: 80 }, (_, i) => tool(`tool-${i}`)), message('after')]
  const compacted = compactTranscriptRuns(source)
  const windowed = transcriptWindow(compacted, 2)

  assert.equal(compacted.length, 3)
  assert.equal(windowed.hiddenItems, 1)
  assert.equal(windowed.hiddenCount, 1)
  assert.equal(windowed.items[0].kind, 'tool-group')
  assert.equal(windowed.items[0].items.length, 80)
  assert.equal(windowed.items[1].messageId, 'after')
})

test('reports hidden source items after compact pagination', () => {
  const source = [...Array.from({ length: 80 }, (_, i) => tool(`tool-${i}`)), message('one'), message('two')]
  const windowed = transcriptWindow(compactTranscriptRuns(source), 2)

  assert.equal(windowed.hiddenItems, 1)
  assert.equal(windowed.hiddenCount, 80)
  assert.deepEqual(windowed.items.map((item) => item.messageId), ['one', 'two'])
})

test('peer messages stay outside collapsed tool runs with their full text', () => {
  const incoming = { kind: 'peer', direction: 'incoming', text: 'full incoming\n'.repeat(20) }
  const outgoing = { kind: 'peer', direction: 'outgoing', text: 'full outgoing\n'.repeat(20) }
  const grouped = compactTranscriptRuns([tool('a'), tool('b'), incoming, tool('c'), outgoing, tool('d')])
  assert.equal(grouped.includes(incoming), true)
  assert.equal(grouped.includes(outgoing), true)
  assert.equal(grouped.filter(item => item.kind === 'peer').length, 2)
  for (const group of grouped.filter(item => item.kind === 'tool-group')) assert.equal(group.items.some(item => item.kind === 'peer'), false)
})
