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
