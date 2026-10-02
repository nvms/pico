import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { deriveState } from '../src/derive.js'
import { readConfig } from '../src/config.js'
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
  const root = await mkdtemp('/tmp/pico-ctl-speed-')
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = join(root, 'home')
  const directory = join(root, 'peers')
  await mkdir(process.env.PICO_HOME, { recursive: true })
  await writeFile(join(process.env.PICO_HOME, 'auth.json'), JSON.stringify({ openai: { access_token: 'test', account_id: 'test', expires_at: Date.now() + 3600000 } }))
  let shellExit
  const boot = {
    cwd: root, root, initialModel: { name: 'codex/supported', provider: 'codex', speed: true },
    speedDefaults: { 'codex/supported': 'fast' },
    models: [{ name: 'codex/supported', provider: 'codex', speed: true }, { name: 'codex/other', provider: 'codex', speed: true }, { name: 'test/model', provider: 'test' }],
    providers: [], autoCompact: false, startupContext: { files: [], stopDir: root },
    tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
    memory: { list: async () => [] }, skills: { list: () => [] },
    mcp: { list: () => [], tools: () => [], terminateAll() {} },
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
  return { controller, remote, calls, root, shellExit: (shell) => shellExit({ id: 'shell-1', command: 'test', exitCode: 0, startedAt: Date.now(), ...shell }) }
}


test('speed persists independently of effort and restores on resume and fork', async t => {
  const { controller: ctl, root } = await fixture(t)
  assert.equal(ctl.state.speed, 'fast')
  ctl.applySpeed('standard')
  assert.equal(ctl.state.effort, undefined)
  await ctl.rename('speed-test')
  const source = ctl.state.session
  assert.equal(deriveState((await loadSession(source.file)).events).speed, 'standard')
  await ctl.fork()
  assert.equal(ctl.state.speed, 'standard')
  await ctl.newSession()
  assert.equal(ctl.state.speed, 'fast')
  await ctl.resume({ file: source.file, header: { root: root } })
  assert.equal(ctl.state.speed, 'standard')
})

test('speed defaults are per model and unsupported models cannot enable Fast', async t => {
  const { controller: ctl } = await fixture(t)
  ctl.switchModelByName('codex/other')
  assert.equal(ctl.state.speed, 'standard')
  ctl.applySpeed('fast', { asDefault: true })
  let config
  for (let attempt = 0; attempt < 100; attempt++) {
    config = await readConfig()
    if (config.speedDefaults?.['codex/other'] === 'fast') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(config.speedDefaults['codex/other'], 'fast')
  ctl.switchModelByName('test/model')
  assert.equal(ctl.speedApplies(), false)
  ctl.applySpeed('fast')
  assert.equal(ctl.state.speed, 'standard')
  ctl.switchModelByName('codex/other')
  assert.equal(ctl.state.speed, 'fast')
  ctl.speedCommand('invalid')
  assert.equal(ctl.state.speed, 'fast')
})

test('initial default is recorded so a later default change cannot alter a session', async t => {
  const { controller: ctl } = await fixture(t)
  await ctl.rename('initial-speed')
  assert.equal(deriveState((await loadSession(ctl.state.session.file)).events).speed, 'fast')
})

test('main turns forward the session speed only to Codex', async t => {
  const { controller: ctl, calls } = await fixture(t)
  ctl.send('fast request')
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.equal(calls[0].speed, 'fast')
  ctl.applySpeed('standard')
  ctl.send('standard request')
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.equal(calls[1].speed, 'standard')
  ctl.switchModelByName('test/model')
  ctl.send('other provider')
  await waitFor(() => calls.length === 3 && !ctl.state.busy)
  assert.equal(calls[2].speed, undefined)
})

test('initial speed does not skip model events recorded before session creation', async t => {
  const { controller: ctl } = await fixture(t)
  ctl.setEffort('high')
  await ctl.rename('pending-settings')
  const { events } = await loadSession(ctl.state.session.file)
  assert.equal(events.find(event => event.type === 'effort').data.to, 'high')
  assert.equal(events.find(event => event.type === 'speed').data.to, 'fast')
})
