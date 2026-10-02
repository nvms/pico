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
  return { controller, remote, calls, shellExit: (shell) => shellExit({ id: 'shell-1', command: 'test', exitCode: 0, startedAt: Date.now(), ...shell }) }
}

test('only explicit names connect; conflicts preserve identity; fork and new disconnect', async t => {
  const { controller: ctl, remote } = await fixture(t)
  assert.equal((await remote.list()).peers.length, 0)
  assert.equal(await ctl.rename('foo'), true)
  const original = ctl.state.session
  assert.equal((await remote.list()).peers[0].name, 'foo')
  assert.equal(await ctl.rename('bar'), false)
  assert.equal(ctl.state.derived.title, 'foo')
  await ctl.fork()
  assert.equal(ctl.state.derived.title, null)
  assert.equal((await remote.list()).peers.length, 0)
  assert.equal((await loadSession(original.file)).events.at(-1).data.text, 'foo')
  await ctl.rename('forked')
  await ctl.newSession()
  assert.equal(ctl.state.session, null)
  assert.equal((await remote.list()).peers.length, 0)
})

test('received messages are durable and visible while held, then wake exactly once', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  ctl.hold(true)
  const receipt = await remote.send({ to: 'foo', message: 'fix the library' })
  assert.equal(calls.length, 0)
  assert.equal(ctl.state.derived.transcript.at(-1).kind, 'peer')
  assert.equal(ctl.state.derived.providerHistory.length, 0)
  const saved = await loadSession(ctl.state.session.file)
  assert.equal(saved.events.some(event => event.type === 'peer_message' && event.data.id === receipt.id), true)
  ctl.hold(false)
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.match(calls[0].history.at(-1).content, /fix the library/)
  assert.equal(calls[0].tools.some(tool => tool.name === 'peer_send'), true)
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 0)
})

test('messages during a turn are visible immediately and processed after it', async t => {
  let finish
  let turns = 0
  const { controller: ctl, remote, calls } = await fixture(t, async () => {
    if (++turns === 1) await new Promise(resolve => { finish = resolve })
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  await ctl.rename('foo')
  ctl.send('start')
  await waitFor(() => !!finish)
  await remote.send({ to: 'foo', message: 'upstream fixed' })
  assert.equal(calls.length, 1)
  assert.equal(ctl.state.overlay.at(-1).kind, 'peer')
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 1)
  finish()
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.match(calls[1].history.at(-1).content, /upstream fixed/)
  assert.equal(ctl.state.derived.transcript.filter(item => item.kind === 'peer').length, 1)
})

test('interrupt prevents peer-triggered work until the user sends again', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  ctl.interrupt()
  await remote.send({ to: 'foo', message: 'wait for user' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls.length, 0)
  ctl.send('continue')
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.match(calls[0].history.at(-1).content, /wait for user/)
})

test('outgoing messages and receipts are independent transcript entries', async t => {
  const { controller: ctl } = await fixture(t, async ({ tools }) => {
    const tool = tools.find(tool => tool.name === 'peer_send')
    await tool.execute({ description: 'Reporting issue', to: 'bar', message: 'all details\nsecond line' })
    return { messages: [{ role: 'assistant', content: 'sent' }] }
  })
  await ctl.rename('foo')
  ctl.send('send the issue')
  await waitFor(() => ctl.state.derived.transcript.some(item => item.kind === 'peer' && item.status === 'delivered') && !ctl.state.busy)
  const items = ctl.state.derived.transcript.filter(item => item.kind === 'peer')
  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'all details\nsecond line')
  assert.equal(items[0].direction, 'outgoing')
})

test('resuming a conflicting archived name stays disconnected and visibly reports conflict', async t => {
  const { controller: ctl, remote } = await fixture(t)
  await ctl.rename('foo')
  const original = ctl.state.session
  await original.flush()
  const { header } = await loadSession(original.file)
  await ctl.newSession()
  await remote.connect({ id: 'remote-id', name: 'foo', cwd: '/library' })
  await ctl.resume({ file: original.file, header })
  assert.equal(ctl.state.derived.title, 'foo')
  assert.equal(ctl.state.peerConnection, null)
  assert.match(ctl.state.peerError, /already connected/)
  await ctl.rename('renamed')
  assert.equal(ctl.state.peerConnection.name, 'renamed')
})

test('a renamed fork never processes messages addressed to its source session', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  ctl.hold(true)
  await remote.send({ to: 'foo', message: 'only for original' })
  await ctl.fork()
  await ctl.rename('fork')
  ctl.hold(false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls.length, 0)
  ctl.send('independent work')
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.equal(calls[0].history.some(message => String(message.content).includes('only for original')), false)
})

test('failed peer persistence is rejected and cannot trigger model work', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  const append = ctl.state.session.append
  ctl.state.session.append = (event, options) => event.type === 'peer_message' ? Promise.reject(new Error('disk full')) : append(event, options)
  await assert.rejects(remote.send({ to: 'foo', message: 'must be persisted' }), /disk full/)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 0)
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 0)
  assert.equal(ctl.state.derived.transcript.some(item => item.kind === 'peer'), false)
})

test('session transitions wait for accepted peer persistence', async t => {
  const { controller: ctl, remote } = await fixture(t)
  await ctl.rename('foo')
  ctl.hold(true)
  const original = ctl.state.session
  const append = original.append
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  original.append = async (event, options) => {
    if (event.type === 'peer_message') { started(); await new Promise(resolve => { release = resolve }) }
    return append(event, options)
  }
  const sent = remote.send({ to: 'foo', message: 'original only' })
  await ready
  const switched = ctl.newSession()
  release()
  await sent
  await switched
  assert.equal(ctl.state.session, null)
  assert.equal((await loadSession(original.file)).events.some(event => event.type === 'peer_message'), true)
})

test('failed rename persistence restores the previous connected identity', async t => {
  const { controller: ctl, remote } = await fixture(t)
  await ctl.rename('foo')
  const append = ctl.state.session.append
  ctl.state.session.append = (event, options) => event.type === 'title' ? Promise.reject(new Error('disk full')) : append(event, options)
  assert.equal(await ctl.rename('other'), false)
  assert.equal(ctl.state.derived.title, 'foo')
  assert.equal((await remote.list()).peers[0].name, 'foo')
})

test('peer pause does not suppress unrelated system notifications', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  ctl.interrupt()
  await remote.send({ to: 'foo', message: 'paused peer request' })
  ctl.noteSystem('background shell finished', { wake: true })
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.match(calls[0].history.at(-1).content, /background shell finished/)
  assert.equal(calls[0].history.some(message => String(message.content).includes('paused peer request')), false)
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 1)
})

test('provider failure retains peer context for an explicit retry without an automatic loop', async t => {
  let fail = true
  const { controller: ctl, remote, calls } = await fixture(t, async () => {
    if (fail) throw new Error('provider unavailable')
    return { messages: [{ role: 'assistant', content: 'recovered' }] }
  })
  await ctl.rename('foo')
  await remote.send({ to: 'foo', message: 'do not lose this request' })
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.equal(ctl.state.peerPaused, true)
  assert.equal(ctl.state.derived.providerHistory.some(message => String(message.content).includes('do not lose this request')), true)
  fail = false
  ctl.send('retry')
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.equal(calls[1].history.some(message => String(message.content).includes('do not lose this request')), true)
})

test('reload restores full incoming and outgoing peer entries without resending or replaying them', async t => {
  const { controller: ctl, remote, calls } = await fixture(t, async ({ tools }) => {
    await tools.find(tool => tool.name === 'peer_send').execute({ to: 'bar', message: 'reply\n"quoted" → café', description: 'Sending reply' })
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  await ctl.rename('foo')
  await remote.send({ to: 'foo', message: 'request\n"quoted" → 日本語' })
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  const session = ctl.state.session
  await session.flush()
  const before = ctl.state.derived.transcript.filter(item => item.kind === 'peer')
  assert.equal(before.length, 2)
  const history = ctl.state.derived.providerHistory
  const { header } = await loadSession(session.file)
  await ctl.newSession()
  await ctl.resume({ file: session.file, header })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(ctl.state.derived.transcript.filter(item => item.kind === 'peer'), before)
  assert.deepEqual(ctl.state.derived.providerHistory, history)
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 0)
  assert.equal(calls.length, 1)
})

test('reload restores unprocessed peer messages and processes them once after reconnecting', async t => {
  const { controller: ctl, remote, calls } = await fixture(t)
  await ctl.rename('foo')
  ctl.hold(true)
  await remote.send({ to: 'foo', message: 'pending across reload' })
  const session = ctl.state.session
  await session.flush()
  const { header } = await loadSession(session.file)
  await ctl.newSession()
  await ctl.resume({ file: session.file, header })
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 1)
  assert.equal(ctl.state.derived.transcript.find(item => item.kind === 'peer').text, 'pending across reload')
  assert.equal(calls.length, 0)
  ctl.hold(false)
  await waitFor(() => calls.length === 1 && !ctl.state.busy)
  assert.match(calls[0].history.at(-1).content, /pending across reload/)
  assert.equal(ctl.state.derived.pendingPeerMessages.length, 0)
})

for (const urgent of [false, true]) test(`peer urgency ${urgent} controls interruption at the next tool boundary`, async t => {
  let boundary, finish
  const { controller: ctl, remote, calls } = await fixture(t, async ({ onStream, signal }) => {
    if (calls.length === 1) {
      await new Promise(resolve => { finish = resolve; boundary = () => onStream({ type: 'tool_complete', call: { id: 'tool-1' } }) })
      return { messages: [{ role: 'assistant', content: 'first turn' }], interrupted: signal.aborted }
    }
    return { messages: [{ role: 'assistant', content: 'peer handled' }] }
  })
  await ctl.rename('foo')
  ctl.send('work')
  await waitFor(() => !!boundary)
  await remote.send({ to: 'foo', message: 'change course', urgent })
  assert.equal(calls[0].signal.aborted, false)
  boundary()
  assert.equal(calls[0].signal.aborted, urgent)
  finish()
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.match(calls[1].history.at(-1).content, /change course/)
  assert.equal(ctl.state.peerPaused, false)
  assert.equal(ctl.state.derived.transcript.find(item => item.kind === 'peer').urgent, urgent)
})

test('urgent peer messages respect a held session at tool boundaries', async t => {
  let boundary, finish
  const { controller: ctl, remote, calls } = await fixture(t, async ({ onStream, signal }) => {
    if (calls.length === 1) {
      await new Promise(resolve => { finish = resolve; boundary = () => onStream({ type: 'tool_complete', call: { id: 'tool-1' } }) })
      return { messages: [{ role: 'assistant', content: 'done' }], interrupted: signal.aborted }
    }
    return { messages: [{ role: 'assistant', content: 'handled' }] }
  })
  await ctl.rename('foo')
  ctl.send('work')
  await waitFor(() => !!boundary)
  ctl.hold(true)
  await remote.send({ to: 'foo', message: 'urgent but held', urgent: true })
  boundary()
  assert.equal(calls[0].signal.aborted, false)
  finish()
  await waitFor(() => !ctl.state.busy)
  assert.equal(calls.length, 1)
  ctl.hold(false)
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
})


test('shell exits are batched into the active turn and persisted once in conversation order', async t => {
  let resume
  const { controller: ctl, calls, shellExit } = await fixture(t, async ({ beforeRequest }) => {
    assert.deepEqual(beforeRequest(), [])
    await new Promise(resolve => { resume = resolve })
    const notes = beforeRequest()
    assert.equal(notes.length, 1)
    assert.match(notes[0].content, /shell-1/)
    assert.match(notes[0].content, /shell-2/)
    assert.deepEqual(beforeRequest(), [])
    return { messages: [{ role: 'assistant', content: 'before' }, ...notes, { role: 'assistant', content: 'after' }] }
  })
  ctl.send('start')
  await waitFor(() => !!resume)
  shellExit({ sessionId: ctl.state.session.id })
  shellExit({ id: 'shell-2', exitCode: 1, sessionId: ctl.state.session.id })
  resume()
  await waitFor(() => !ctl.state.busy)
  assert.equal(calls.length, 1)
  const history = ctl.state.derived.providerHistory
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user', 'assistant'])
  await ctl.state.session.flush()
  const saved = await loadSession(ctl.state.session.file)
  assert.equal(saved.events.filter(e => e.type === 'system_note').length, 1)
})

test('shell notes not consumed during the active turn wake a follow-up turn', async t => {
  let resume
  const { controller: ctl, calls, shellExit } = await fixture(t, async () => {
    if (!resume) await new Promise(resolve => { resume = resolve })
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  ctl.send('start')
  await waitFor(() => !!resume)
  shellExit({ sessionId: ctl.state.session.id })
  resume()
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.match(calls[1].history.at(-1).content, /shell-1/)
})

test('holding a turn keeps shell notes queued until released', async t => {
  let resume
  const { controller: ctl, calls, shellExit } = await fixture(t, async ({ beforeRequest }) => {
    if (!resume) {
      await new Promise(resolve => { resume = resolve })
      assert.deepEqual(beforeRequest(), [])
    }
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  ctl.send('start')
  await waitFor(() => !!resume)
  ctl.hold(true)
  shellExit({ sessionId: ctl.state.session.id })
  resume()
  await waitFor(() => !ctl.state.busy)
  assert.equal(calls.length, 1)
  ctl.hold(false)
  await waitFor(() => calls.length === 2 && !ctl.state.busy)
  assert.match(calls[1].history.at(-1).content, /shell-1/)
})

test('model shell kills stay silent and user shell kills do not wake an idle model', async t => {
  const { controller: ctl, calls, shellExit } = await fixture(t)
  await ctl.rename('shell-kills')
  shellExit({ killedBy: 'model', sessionId: ctl.state.session.id })
  assert.equal(ctl.state.events.filter(e => e.type === 'system_note').length, 0)
  shellExit({ killedBy: 'user', sessionId: ctl.state.session.id })
  assert.equal(calls.length, 0)
  assert.match(ctl.state.events.find(e => e.type === 'system_note').data.text, /manually killed/)
})

test('shell exits from another session stay outside the active conversation', async t => {
  let resume
  const { controller: ctl, calls, shellExit } = await fixture(t, async ({ beforeRequest }) => {
    await new Promise(resolve => { resume = resolve })
    assert.deepEqual(beforeRequest(), [])
    return { messages: [{ role: 'assistant', content: 'done' }] }
  })
  ctl.send('start')
  await waitFor(() => !!resume)
  shellExit({ sessionId: 'other-session' })
  resume()
  await waitFor(() => !ctl.state.busy)
  assert.equal(calls.length, 1)
  assert.equal(ctl.state.events.filter(e => e.type === 'system_note').length, 0)
})
