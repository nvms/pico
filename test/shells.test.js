import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShellManager } from '../src/core/shells.js'

const exited = (mgr, id) =>
  new Promise((resolve) => {
    const check = () => {
      const shell = mgr.list().find((s) => s.id === id)
      if (shell?.status === 'exited') resolve(shell)
      else setTimeout(check, 25)
    }
    check()
  })

test('captures output and exit code, notifies on exit', async () => {
  let exitedShell = null
  const mgr = createShellManager({ onExit: (s) => { exitedShell = s } })
  const { id } = mgr.start('printf "one\\ntwo\\n"; exit 3', { sessionId: 'session-1', sessionFile: '/tmp/session-1.jsonl' })
  const shell = await exited(mgr, id)
  assert.equal(shell.exitCode, 3)
  assert.equal(shell.sessionId, 'session-1')
  assert.equal(shell.sessionFile, '/tmp/session-1.jsonl')
  assert.equal(exitedShell.id, id)
  assert.equal(exitedShell.sessionId, 'session-1')
  assert.equal(exitedShell.sessionFile, '/tmp/session-1.jsonl')
  const out = mgr.output(id, { tail: 10 })
  assert.equal(out.output, 'one\ntwo')
  assert.equal(out.status, 'exited')
})

test('kill stops a running shell and records who asked', async () => {
  const mgr = createShellManager()
  const { id } = mgr.start('sleep 30')
  assert.equal(mgr.running(), 1)
  mgr.kill(id, 'user')
  const shell = await exited(mgr, id)
  assert.equal(shell.killedBy, 'user')
  assert.equal(mgr.running(), 0)
})

test('dismiss removes exited shells only', async () => {
  const mgr = createShellManager()
  const { id } = mgr.start('true')
  await exited(mgr, id)
  mgr.dismiss(id)
  assert.equal(mgr.list().length, 0)
  assert.throws(() => mgr.output(id), /no shell/)
})

test('tail returns only the requested lines', async () => {
  const mgr = createShellManager()
  const { id } = mgr.start('seq 1 50')
  await exited(mgr, id)
  const out = mgr.output(id, { tail: 3 })
  assert.equal(out.output, '48\n49\n50')
  assert.equal(out.totalLines, 50)
})
