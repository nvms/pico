import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { createContextTracker } from '../src/context.js'
import { loadSession } from '../src/session.js'

const summary = Array.from({ length: 8 }, (_, i) => `${i + 1}. Section:\n   task state`).join('\n')
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

async function fixture(t, compactRun = async () => summary) {
  const root = await mkdtemp('/tmp/pico-compaction-')
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = join(root, 'home')
  const boot = {
    cwd: root, root, initialModel: { name: 'test/model', provider: 'test', context: 1000 }, models: [],
    providers: [], autoCompact: false, startupContext: { files: [], stopDir: root },
    tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
    memory: { list: async () => [] }, skills: { list: () => [] },
    mcp: { list: () => [], tools: () => [], terminateAll() {} },
    shells: { killAll() {} }, git: { refresh() {} },
    setMcpNotify() {}, setShellsNotify() {}, setWakeupsNotify() {}, setGitNotify() {}, setWakeupsFire() {}, setShellsExit() {},
  }
  const calls = []
  const controller = createController({ boot, compactRun, peerDirectory: join(root, 'peers'), run: async args => {
    calls.push(args)
    return {
      messages: [{ role: 'assistant', content: 'task progress' }],
      usage: { input_tokens: 900, output_tokens: 10 },
      lastPromptTokens: calls.length === 2 ? 900 : 100,
    }
  } })
  t.after(async () => {
    await controller.shutdown()
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  controller.send('start task')
  await waitFor(() => calls.length === 1 && !controller.state.busy)
  return { ctl: controller, calls, boot }
}

async function secondTurn(ctl, calls) {
  ctl.send('keep working')
  await waitFor(() => calls.length >= 2 && !ctl.state.busy)
}

const notices = ctl => ctl.state.events.filter(event => event.type === 'system_note')

test('automatic compaction persists a notice and wakes a continuation turn', async t => {
  const { ctl, calls, boot } = await fixture(t)
  boot.autoCompact = true
  await secondTurn(ctl, calls)
  await waitFor(() => calls.length === 3 && !ctl.state.busy)
  assert.equal(ctl.state.compactOutcome, 'done')
  assert.equal(notices(ctl).length, 1)
  assert.match(calls[2].history.at(-1).content, /automatically compacted/)
  assert.match(calls[2].history.at(-1).content, /Continue any unfinished work/)
  await ctl.state.session.flush()
  const saved = await loadSession(ctl.state.session.file)
  assert.equal(saved.events.filter(event => event.type === 'system_note').length, 1)
})

test('manual compaction does not add a notice or wake a turn', async t => {
  const { ctl, calls } = await fixture(t)
  await secondTurn(ctl, calls)
  await ctl.compact('focus on pending work')
  assert.equal(ctl.state.compactOutcome, 'done')
  assert.equal(calls.length, 2)
  assert.equal(notices(ctl).length, 0)
  assert.equal(ctl.state.busy, false)
})

test('failed automatic compaction does not wake a turn', async t => {
  const { ctl, calls, boot } = await fixture(t, async () => { throw new Error('provider failed') })
  boot.autoCompact = true
  await secondTurn(ctl, calls)
  await waitFor(() => ctl.state.compactOutcome === 'failed')
  assert.equal(calls.length, 2)
  assert.equal(notices(ctl).length, 0)
})

test('cancelled automatic compaction does not persist a summary or wake a turn', async t => {
  let finish
  const { ctl, calls, boot } = await fixture(t, () => new Promise(resolve => { finish = resolve }))
  boot.autoCompact = true
  ctl.send('keep working')
  await waitFor(() => finish)
  ctl.interrupt()
  finish(summary)
  await waitFor(() => !ctl.state.busy)
  assert.equal(ctl.state.compactOutcome, 'cancelled')
  assert.equal(calls.length, 2)
  assert.equal(notices(ctl).length, 0)
  assert.equal(ctl.state.events.some(event => event.type === 'compact'), false)
})

test('automatic compaction continuation respects hold and wakes once on release', async t => {
  let finish
  const { ctl, calls, boot } = await fixture(t, () => new Promise(resolve => { finish = resolve }))
  boot.autoCompact = true
  ctl.send('keep working')
  await waitFor(() => finish)
  ctl.hold(true)
  finish(summary)
  await waitFor(() => !ctl.state.busy)
  assert.equal(ctl.state.compactOutcome, 'done')
  assert.equal(calls.length, 2)
  ctl.hold(false)
  await waitFor(() => calls.length === 3 && !ctl.state.busy)
  assert.equal(notices(ctl).length, 1)
})
