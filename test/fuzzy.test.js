import test from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyScore, rankFuzzy } from '../src/ui/fuzzy.js'

test('contiguous matches rank by distance from the beginning', () => {
  const values = ['abc hello', 'hello world', 'ab hello', 'a hello']
  assert.deepEqual(
    rankFuzzy(values, 'hello', (query, value) => fuzzyScore(query, value)),
    ['hello world', 'a hello', 'ab hello', 'abc hello'],
  )
})

test('provider-prefix model matches rank before later model-name matches', () => {
  const values = [
    'openai/gpt-5.3-codex-spark',
    'openai/gpt-5.3-codex',
    'codex/gpt-5.3-codex',
    'codex/gpt-5.2-codex',
  ]
  assert.deepEqual(
    rankFuzzy(values, 'codex', (query, value) => fuzzyScore(query, value)),
    [
      'codex/gpt-5.3-codex',
      'codex/gpt-5.2-codex',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.3-codex-spark',
    ],
  )
})

test('fuzzy matches remain available when no contiguous match exists', () => {
  assert.ok(fuzzyScore('cdx', 'codex/gpt') >= 0)
})
