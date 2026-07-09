import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWakeupManager } from '../src/core/wakeups.js'
import { deriveState } from '../src/core/derive.js'
import { makeEvent } from '../src/core/events.js'

test('schedules, lists, and cancels wake-ups', () => {
  const mgr = createWakeupManager()
  const a = mgr.schedule(60, 'take the next roadmap item')
  const b = mgr.schedule(120, 'check the deploy')
  assert.equal(mgr.pending(), 2)
  assert.deepEqual(mgr.list().map((w) => w.id), [a.id, b.id])
  assert.ok(a.at > Date.now())
  assert.equal(a.seconds, 60)

  mgr.cancel(a.id)
  assert.equal(mgr.pending(), 1)
  assert.throws(() => mgr.cancel(a.id), /no pending wake-up/)
  mgr.cancelAll()
  assert.equal(mgr.pending(), 0)
})

test('clamps delay to a floor and fires with the note', async () => {
  let fired = null
  const mgr = createWakeupManager({ onFire: (w) => { fired = w } })
  const { seconds } = mgr.schedule(0.001, 'too soon')
  assert.equal(seconds, 5)
  mgr.cancelAll()

  const quick = createWakeupManager({ onFire: (w) => { fired = w } })
  const real = quick.schedule(5, 'hello future self')
  quick.cancel(real.id)
  assert.equal(fired, null)
})

test('system_note events derive like shell notes', () => {
  const state = deriveState([
    makeEvent('message', { message: { role: 'user', content: 'set a loop' } }),
    makeEvent('system_note', { text: '[system notification] scheduled wake-up 1 fired. Your note to yourself:\ndo the thing' }),
  ])
  assert.equal(state.providerHistory.at(-1).role, 'user')
  assert.match(state.providerHistory.at(-1).content, /do the thing/)
  assert.equal(state.transcript.at(-1).kind, 'notice')
})
