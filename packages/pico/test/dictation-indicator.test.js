import test from 'node:test'
import assert from 'node:assert/strict'
import { appendLevel, dictationIndicator } from '../src/ui/dictation-indicator.js'

test('waveform reflects samples and has a fixed width', () => {
  assert.equal(dictationIndicator('recording', []), ` ${'▁'.repeat(16)} recording `)
  assert.equal(dictationIndicator('recording', [0, 1]), ` ${'▁'.repeat(15)}█ recording `)
  let levels = []
  for (let i = 0; i < 100; i++) levels = appendLevel(levels, i / 99)
  assert.equal(levels.length, 16)
  assert.equal(levels.at(-1), 1)
  assert.equal(dictationIndicator('recording', levels).length, dictationIndicator('recording', []).length)
})

test('levels are clamped and clear outside recording', () => {
  assert.deepEqual(appendLevel([], -1), [0])
  assert.deepEqual(appendLevel([], 2), [1])
  assert.equal(dictationIndicator('idle', [1]), '')
  assert.equal(dictationIndicator('transcribing', [1]), ' transcribing ')
  assert.equal(dictationIndicator('loading', []), ' loading ')
})
