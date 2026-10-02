import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemonRuntime } from '../src/daemon-runtime.js'
import { serveDaemon, connectDaemon } from '../src/daemon-transport.js'
import { createRemoteController } from '../src/remote-controller.js'

function factory() {
  const controllers = []
  const createSession = async () => {
    const listeners = new Map()
    const ctl = {
      state: { session: { id: String(controllers.length + 1) }, derived: { title: null }, busy: false, attachments: new Map() },
      boot: { root: '/workspace', commands: { list: () => [] }, shells: { list: () => [], running: () => 0 } },
      agents: { list: () => [] },
      on(type, fn) { listeners.set(type, fn); return () => listeners.delete(type) },
      rename(title) { ctl.state.derived.title = title; listeners.get('change')?.(); return true },
      send(text) { ctl.state.text = text; listeners.get('change')?.() },
      interrupt() { ctl.state.busy = false },
      shutdown() { ctl.closed = true },
      activity: () => [],
    }
    controllers.push(ctl)
    return ctl
  }
  return { controllers, createSession }
}
const client = () => ({ send() {} })

test('unnamed leases expire only after last viewer; named owners survive detach', async () => {
  const fake = factory()
  const runtime = createDaemonRuntime(fake)
  const a = client(), b = client()
  const first = await runtime.dispatch(a, { op: 'create' })
  await runtime.dispatch(b, { op: 'attach', id: first.id })
  await runtime.disconnect(a)
  assert.equal(fake.controllers[0].closed, undefined)
  await runtime.disconnect(b)
  assert.equal(fake.controllers[0].closed, true)
  const second = await runtime.dispatch(a, { op: 'create' })
  await runtime.dispatch(a, { op: 'call', id: second.id, args: ['controller', 'rename', 'named'] })
  await runtime.disconnect(a)
  assert.equal(fake.controllers[1].closed, undefined)
  assert.equal((await runtime.dispatch(b, { op: 'list' }))[0].title, 'named')
  await runtime.dispatch(b, { op: 'demote', id: second.id })
  assert.equal(fake.controllers[1].closed, true)
  await runtime.close()
})

test('busy demotion refuses; viewed demotion keeps owner; actions serialize', async () => {
  const fake = factory()
  const runtime = createDaemonRuntime(fake)
  const a = client()
  const { id } = await runtime.dispatch(a, { op: 'create' })
  const ctl = fake.controllers[0]
  ctl.state.busy = true
  await assert.rejects(runtime.dispatch(a, { op: 'demote', id }), /interrupt/)
  await runtime.dispatch(a, { op: 'interrupt', id })
  await runtime.dispatch(a, { op: 'demote', id })
  assert.equal(ctl.closed, undefined)
  const order = []
  ctl.action = async value => { order.push(value); await new Promise(r => setTimeout(r, 5)); order.push(-value) }
  await Promise.all([1, 2].map(value => runtime.dispatch(a, { op: 'call', id, args: ['controller', 'action', value] })))
  assert.deepEqual(order, [1, -1, 2, -2])
  await runtime.close()
})

test('real private socket delivers snapshots to multiple stable facades', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pico-daemon-test-'))
  const paths = { directory, socket: join(directory, 'daemon.sock') }
  const fake = factory()
  const server = await serveDaemon({ paths, createSession: fake.createSession, idleMs: 10000 })
  const a = await connectDaemon(paths), b = await connectDaemon(paths)
  try {
    assert.equal((await stat(paths.socket)).mode & 0o777, 0o600)
    const first = await createRemoteController(a)
    const second = await createRemoteController(b, { id: first.id })
    const state = second.state
    const updated = new Promise(resolve => second.on('change', resolve))
    await first.send('hello')
    await updated
    assert.equal(second.state, state)
    assert.equal(state.text, 'hello')
    assert.ok(state.attachments instanceof Map)
    await first.shutdown()
    assert.equal(fake.controllers[0].closed, undefined)
    await second.shutdown()
    assert.equal(fake.controllers[0].closed, true)
  } finally { a.close(); b.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('switching preserves named execution owner and stable remote identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pico-switch-test-'))
  const paths = { directory, socket: join(directory, 'daemon.sock') }
  const fake = factory()
  const server = await serveDaemon({ paths, createSession: fake.createSession, idleMs: 10000 })
  const connection = await connectDaemon(paths)
  try {
    const ctl = await createRemoteController(connection)
    const state = ctl.state, boot = ctl.boot, firstId = ctl.id
    await ctl.rename('first')
    fake.controllers[0].state.busy = true
    await ctl.newSession('  second feature  ')
    assert.equal(ctl.state.derived.title, 'second feature')
    assert.notEqual(ctl.id, firstId)
    assert.equal(ctl.state, state)
    assert.equal(ctl.boot, boot)
    assert.equal(fake.controllers[0].closed, undefined)
    assert.equal(fake.controllers[0].state.busy, true)
    const secondId = ctl.id
    await boot.workspace.demote(secondId)
    await boot.workspace.select(firstId)
    assert.equal(ctl.id, firstId)
    assert.equal(fake.controllers[1].closed, true)
    assert.equal(ctl.state.busy, true)
    await boot.workspace.interrupt(firstId)
    await boot.workspace.demote(firstId)
    assert.equal((await boot.workspace.list()).length, 0)
    await ctl.shutdown()
    assert.equal(fake.controllers[0].closed, true)
    assert.notEqual(firstId, secondId)
  } finally { connection.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('live previews retain original owner, stream selected state, cancel and enter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pico-preview-test-'))
  const fake = factory()
  const paths = { directory, socket: join(directory, 'daemon.sock') }
  const server = await serveDaemon({ paths, createSession: fake.createSession, idleMs: 10000 })
  const connection = await connectDaemon(paths)
  try {
    const ctl = await createRemoteController(connection)
    const originalId = ctl.id
    const other = await createRemoteController(connection)
    await other.rename('preview')
    const otherId = other.id
    await other.shutdown()
    await ctl.boot.workspace.preview(otherId)
    assert.equal(ctl.id, originalId)
    assert.equal(ctl.state.derived.title, 'preview')
    assert.equal(fake.controllers[0].closed, undefined)
    fake.controllers[1].state.busy = true
    fake.controllers[1].send('live update')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(ctl.state.busy, true)
    await ctl.boot.workspace.cancelPreview()
    assert.equal(ctl.id, originalId)
    assert.equal(ctl.state.derived.title, null)
    assert.equal(ctl.state.busy, false)
    await Promise.all([ctl.boot.workspace.preview(otherId), ctl.boot.workspace.preview(originalId), ctl.boot.workspace.preview(otherId)])
    assert.equal(ctl.state.derived.title, 'preview')
    await ctl.boot.workspace.select(otherId)
    assert.equal(ctl.id, otherId)
    assert.equal(fake.controllers[0].closed, true)
    await ctl.boot.workspace.interrupt(otherId)
    await ctl.boot.workspace.demote(otherId)
    await ctl.shutdown()
  } finally { connection.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
