import test from 'node:test'
import assert from 'node:assert/strict'
import { activityRows, activityStripSizes, stripWindowStart } from '../src/ui/activity-strip.js'

const heightUsed = (lengths, sizes, margin = 1) => margin + 1 + lengths.filter(Boolean).length + sizes.reduce((sum, size, i) => sum + size + Number(size < lengths[i]), 0)

test('empty groups have no rows; nonempty groups always have at least one', () => {
  assert.deepEqual(activityStripSizes(24, [0, 0]), [0, 0])
  assert.deepEqual(activityStripSizes(5, [100, 100]), [1, 1])
  assert.deepEqual(activityStripSizes(5, [0, 100]), [0, 1])
})

test('shares the height budget and reallocates unused capacity', () => {
  assert.deepEqual(activityStripSizes(60, [100, 100]), [3, 3])
  assert.deepEqual(activityStripSizes(60, [1, 100]), [1, 6])
  assert.deepEqual(activityStripSizes(60, [100, 0]), [8, 0])
  assert.deepEqual(activityStripSizes(100, [100, 100]), [7, 7])
})

test('accounts for spacing, hints, main, and hidden counts', () => {
  assert.deepEqual(activityStripSizes(30, [100, 0], 0), [3, 0])
  assert.deepEqual(activityStripSizes(40, [2, 2]), [2, 2])
  for (let height = 1; height <= 150; height++) {
    for (const lengths of [[100, 100], [1, 100], [100, 0], [2, 2], [0, 1]]) {
      const sizes = activityStripSizes(height, lengths)
      const minimum = lengths.map((n) => Number(n > 0))
      assert.ok(heightUsed(lengths, sizes) <= Math.max(Math.floor(height * 0.2), heightUsed(lengths, minimum)))
      assert.ok(sizes.every((n, i) => n <= lengths[i] && (!lengths[i] || n >= 1)))
    }
  }
})

test('keeps the target visible for single-row windows and after shrinking', () => {
  for (const size of [1, 2, 3, 10]) {
    for (let target = 0; target < 20; target++) {
      const start = stripWindowStart(15, target, 20, size)
      assert.ok(start <= target && target < start + size)
    }
  }
  assert.equal(stripWindowStart(15, -1, 20, 10), 10)
})

test('prioritizes active tasks without changing recency within each group', () => {
  const rows = [{ id: 4, status: 'done' }, { id: 3, status: 'running' }, { id: 2, status: 'queued' }, { id: 1, status: 'done' }]
  assert.deepEqual(activityRows(rows).map((row) => row.id), [3, 2, 4, 1])
  assert.equal(rows[0].id, 4)
})
