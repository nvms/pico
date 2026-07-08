import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionContext, applyCompletion } from '../src/ui/completion.js'

const COLORS = ['red', 'blue', 'green']
const MODELS = ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite']
const resolve = (name) => (name === 'color' ? COLORS : name === 'model' ? MODELS : null)

test('no context without a command, argument space, or source', () => {
  assert.equal(completionContext({ value: 'hello', resolve }), null)
  assert.equal(completionContext({ value: '/color', resolve }), null)
  assert.equal(completionContext({ value: '/rename foo', resolve }), null)
  assert.equal(completionContext({ value: '/color bl\nue', resolve }), null)
})

test('empty partial offers everything, typing narrows', () => {
  const all = completionContext({ value: '/color ', resolve })
  assert.deepEqual(all.matches, COLORS)
  const narrowed = completionContext({ value: '/color bl', resolve })
  assert.deepEqual(narrowed.matches, ['blue'])
})

test('fuzzy ranking puts the best model first and apply inserts it', () => {
  const ctx = completionContext({ value: '/model fla', resolve })
  assert.equal(ctx.matches[0], 'google/gemini-2.5-flash')
  assert.equal(applyCompletion('/model fla', ctx, ctx.matches[0]), '/model google/gemini-2.5-flash ')
})

test('completes only the last token', () => {
  const ctx = completionContext({ value: '/color red bl', resolve })
  assert.equal(ctx.partial, 'bl')
  assert.equal(applyCompletion('/color red bl', ctx, 'blue'), '/color red blue ')
})
