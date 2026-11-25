import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { createContextTracker } from '../src/context.js'

test('a call still running shows what it was called with', async t => {
  const root = await mkdtemp('/tmp/pico-running-')
  const previousHome = process.env.PICO_HOME
  process.env.PICO_HOME = join(root, 'home')
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  const boot = {
    cwd: root, root, initialModel: { name: 'test/model', provider: 'test' }, models: [],
    providers: [], autoCompact: false, startupContext: { files: [], stopDir: root },
    tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
    memory: { list: async () => [] }, skills: { list: () => [] },
    mcp: { list: () => [], tools: () => [], starting: () => [], ready: async () => {}, terminateAll() {} },
    shells: { killAll() {} }, wakeups: { cancelAll() {} }, git: { refresh() {}, dispose() {} },
    setMcpNotify() {}, setShellsNotify() {}, setWakeupsNotify() {}, setGitNotify() {}, setWakeupsFire() {}, setShellsExit() {},
  }
  let running
  const seen = new Promise(resolve => { running = resolve })
  const ctl = createController({ boot, peerDirectory: join(root, 'peers'), run: async ({ onStream, signal }) => {
    const call = { id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'ls -la', description: 'List files' }) } }
    onStream({ type: 'tool_calls_ready', calls: [call] })
    onStream({ type: 'tool_executing', call })
    running()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { messages: [], interrupted: true }
  } })
  ctl.send('go')
  await seen
  await new Promise(resolve => setTimeout(resolve, 50))
  const tool = ctl.state.overlay.find(item => item.kind === 'tool' && item.callId === 'c1')
  assert.equal(tool.status, 'running')
  assert.equal(tool.args.command, 'ls -la')
  await ctl.shutdown()
})
