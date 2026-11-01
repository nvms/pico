import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { createPeers } from '../src/peers.js'
import { loadSession } from '../src/session.js'
import { createContextTracker } from '../src/context.js'

const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

async function fixture(t, run) {
  const root = await mkdtemp('/tmp/pico-ctl-peer-')
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = join(root, 'home')
  const directory = join(root, 'peers')
  let shellExit
  const boot = {
    cwd: root, root, initialModel: { name: 'test/model', provider: 'test' }, models: [{ name: 'test/model', provider: 'test' }],
    providers: [], autoCompact: false, startupContext: { files: [], stopDir: root },
    tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
    memory: { list: async () => [] }, skills: { list: () => [] },
    mcp: { list: () => [], tools: () => [], starting: () => [], ready: async () => {}, terminateAll() {} },
    shells: { killAll() {}, output() { return { output: 'shell output' } } }, git: { refresh() {} },
    setMcpNotify() {}, setShellsNotify() {}, setWakeupsNotify() {}, setGitNotify() {}, setWakeupsFire() {}, setShellsExit(handler) { shellExit = handler },
  }
  const calls = []
  const controller = createController({ boot, peerDirectory: directory, run: async args => {
    calls.push(args)
    return run ? run(args) : { messages: [{ role: 'assistant', content: 'done' }] }
  } })
  const remote = createPeers({ directory, onMessage: async () => {} })
  await remote.connect({ id: 'remote-id', name: 'bar', cwd: '/library' })
  t.after(async () => {
    await controller.shutdown()
    await remote.disconnect()
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  return { controller, remote, calls, shellExit: (shell) => shellExit({ id: 'shell-1', command: 'test', exitCode: 0, startedAt: Date.now(), ...shell }) }
}

// the user messages the session saved, with whether each was spoken
const saved = ctl => ctl.state.events
  .filter(e => e.type === 'message' && e.data.message.role === 'user')
  .map(e => [e.data.message.content, !!e.data.spoken])

test('a spoken message that waits for a turn keeps its mark, and lends it to no other', async t => {
  let finish
  let turns = 0
  const { controller: ctl } = await fixture(t, async () => {
    if (++turns === 1) await new Promise(resolve => { finish = resolve })
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  // the second arrives before the first is saved, as a message sent twice
  // in a moment does
  ctl.send('first', { spoken: true })
  ctl.send('again', { spoken: true })
  await waitFor(() => !!finish)
  finish()
  await waitFor(() => turns === 2 && !ctl.state.busy)
  assert.deepEqual(saved(ctl), [['first', true], ['again', true]])
})

test('a spoken message arriving as a typed one starts marks only itself', async t => {
  let finish
  let turns = 0
  const { controller: ctl } = await fixture(t, async () => {
    if (++turns === 1) await new Promise(resolve => { finish = resolve })
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  ctl.send('typed')
  ctl.send('spoken', { spoken: true })
  await waitFor(() => !!finish)
  finish()
  await waitFor(() => turns === 2 && !ctl.state.busy)
  assert.deepEqual(saved(ctl), [['typed', false], ['spoken', true]])
})
