import test from 'node:test'
import assert from 'node:assert/strict'
import { deliberationsFromEvents } from '../src/core/deliberation-history.js'

function event(type, at, data) {
  return { id: `${type}-${at}`, type, at, data }
}

test('reconstructs deliberations from persisted events', () => {
  const rows = deliberationsFromEvents([
    event('deliberation_start', 10, { deliberationId: '1', brief: 'Choose storage', rounds: 2, model: 'worker' }),
    event('deliberation_event', 11, { deliberationId: '1', role: 'proposer', round: 1, event: { type: 'tool_executing', call: { id: 'call-1' } } }),
    event('deliberation_turn', 12, { deliberationId: '1', role: 'proposer', round: 1, text: 'Use SQLite', usage: { totalTokens: 4 } }),
    event('deliberation_turn', 13, { deliberationId: '1', role: 'reviewer', round: 1, text: 'Check concurrency', usage: { totalTokens: 5 } }),
    event('deliberation_result', 14, { deliberationId: '1', result: 'Use SQLite with WAL', usage: { totalTokens: 3 } }),
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'deliberation-1')
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].description, 'Choose storage')
  assert.deepEqual(rows[0].turns.map(({ role, text }) => [role, text]), [
    ['proposer', 'Use SQLite'],
    ['reviewer', 'Check concurrency'],
  ])
  assert.equal(rows[0].events[0].role, 'proposer')
  assert.equal(rows[0].result, 'Use SQLite with WAL')
  assert.equal(rows[0].usage.totalTokens, 12)
})

test('dismissed deliberations stay hidden after restore', () => {
  const rows = deliberationsFromEvents([
    event('deliberation_start', 10, { deliberationId: '1', brief: 'Choose' }),
    event('deliberation_result', 11, { deliberationId: '1', result: 'Done' }),
    event('deliberation_dismiss', 12, { deliberationId: '1' }),
  ])
  assert.deepEqual(rows, [])
})

test('keeps incomplete deliberations reviewable and sorts newest first', () => {
  const rows = deliberationsFromEvents([
    event('deliberation_start', 10, { deliberationId: '1', brief: 'Old' }),
    event('deliberation_start', 20, { deliberationId: '2', brief: 'New' }),
    event('deliberation_result', 21, { deliberationId: '2', error: 'failed' }),
  ])

  assert.deepEqual(rows.map(({ deliberationId }) => deliberationId), ['2', '1'])
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows[1].status, 'running')
})
