import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { createContextTracker } from '../src/context.js'
import { loadSession } from '../src/session.js'

test('shutdown waits for interrupted work to persist and cancels owned resources', async t => {
  const root = await mkdtemp('/tmp/pico-shutdown-')
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = join(root, 'home')
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  const disposed = []
  let started
  const ready = new Promise(resolve => { started = resolve })
  const boot = {
    cwd: root, root, initialModel: { name: 'test/model', provider: 'test' }, models: [],
    providers: [], autoCompact: false, startupContext: { files: [], stopDir: root },
    tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
    memory: { list: async () => [] }, skills: { list: () => [] },
    mcp: { list: () => [], tools: () => [], terminateAll() { disposed.push('mcp') } },
    shells: { killAll() { disposed.push('shells') } },
    wakeups: { cancelAll() { disposed.push('wakeups') } },
    git: { refresh() {}, dispose() { disposed.push('git') } },
    setMcpNotify() {}, setShellsNotify() {}, setWakeupsNotify() {}, setGitNotify() {}, setWakeupsFire() {}, setShellsExit() {},
  }
  const ctl = createController({ boot, peerDirectory: join(root, 'peers'), run: async ({ signal }) => {
    started()
    await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }))
    return { messages: [{ role: 'assistant', content: 'interrupted safely' }], interrupted: true }
  } })
  ctl.send('begin')
  await ready
  const file = ctl.state.session.file
  await ctl.shutdown()
  assert.equal(ctl.state.busy, false)
  const saved = await loadSession(file)
  assert.equal(saved.events.some(event => event.type === 'interrupt'), true)
  assert.equal(saved.events.some(event => event.type === 'message' && event.data.message.content === 'interrupted safely'), true)
  assert.deepEqual(new Set(disposed), new Set(['shells', 'wakeups', 'mcp', 'git']))
  ctl.send('do not run')
  assert.equal(ctl.state.busy, false)
})
