import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createPeers } from '../src/peers.js'

async function fixture(t) {
  const directory = await mkdtemp('/tmp/pico-peer-test-')
  const instances = []
  t.after(async () => {
    await Promise.all(instances.map(peer => peer.disconnect()))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, make: (options = {}) => {
    const peer = createPeers({ directory, onMessage: async () => {}, ...options })
    instances.push(peer)
    return peer
  } }
}
const connect = (peer, id, name = id) => peer.connect({ id, name, cwd: `/project/${id}` })

function raw(path, data) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let response = ''
    socket.on('connect', () => socket.write(data))
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(JSON.parse(response)))
    socket.on('error', reject)
  })
}

test('discovery crosses projects, status stays live, Unicode delivery waits for persistence', async t => {
  const { make } = await fixture(t)
  let release
  const stored = new Promise(resolve => { release = resolve })
  const received = []
  const a = make(), b = make({ onMessage: async value => { received.push(value); await stored } })
  await connect(a, 'a', 'foo'); await connect(b, 'b', 'bar')
  b.setStatus('busy')
  assert.deepEqual((await a.list()).peers, [{ id: 'b', name: 'bar', cwd: '/project/b', status: 'busy' }])
  let delivered = false
  const sending = a.send({ to: 'bar', message: 'こんにちは → café' }).then(value => { delivered = true; return value })
  while (!received.length) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(delivered, false)
  release()
  const receipt = await sending
  assert.equal(receipt.status, 'delivered')
  assert.equal(received[0].message, 'こんにちは → café')
})

test('conflicting claims never remove the original owner', async t => {
  const { make } = await fixture(t)
  const a = make(), b = make(), duplicate = make()
  await connect(a, 'a', 'foo'); await connect(b, 'b', 'bar')
  await assert.rejects(connect(duplicate, 'c', 'foo'), /already connected/)
  await assert.rejects(connect(duplicate, 'a', 'other'), /already connected/)
  await assert.rejects(connect(a, 'a', 'bar'), /already connected/)
  assert.equal(a.identity.name, 'foo')
  assert.equal((await b.send({ to: 'foo', message: 'still reachable' })).status, 'delivered')
  assert.equal((await a.send({ to: 'bar', message: 'you too' })).status, 'delivered')
})

test('simultaneous claims have exactly one winner', async t => {
  const { make } = await fixture(t)
  const contenders = [make(), make(), make()]
  const results = await Promise.allSettled(contenders.map((peer, i) => connect(peer, String(i), 'shared')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
})

test('renames preserve stable-ID routing and disconnect releases both claims', async t => {
  const { make } = await fixture(t)
  const a = make(), b = make(), replacement = make()
  await connect(a, 'a'); await connect(b, 'b', 'bar')
  await connect(b, 'b', 'renamed')
  await assert.rejects(a.send({ to: 'bar', message: 'hello' }), /offline/)
  assert.equal((await a.send({ to: 'b', message: 'hello' })).to.name, 'renamed')
  await Promise.all([b.disconnect(), b.disconnect()])
  await connect(replacement, 'b', 'renamed')
  await assert.rejects(replacement.send({ to: 'b', message: 'self' }), /yourself/)
})

test('wire protocol validates messages, deduplicates retries, and rejects stale destinations', async t => {
  const { directory, make } = await fixture(t)
  const messages = []
  const a = make(), b = make({ onMessage: value => { messages.push(value) } })
  await connect(a, 'a'); await connect(b, 'b')
  const records = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8'))
  const sender = records.find(record => record.id === 'a'), target = records.find(record => record.id === 'b')
  const request = { v: 1, type: 'deliver', to: 'b', instance: target.instance, fromId: 'a', fromInstance: sender.instance, messageId: 'retry', message: 'once' }
  assert.equal((await raw(target.socket, JSON.stringify(request) + '\n')).ok, true)
  assert.equal((await raw(target.socket, JSON.stringify(request) + '\n')).ok, true)
  assert.equal(messages.length, 1)
  assert.match((await raw(target.socket, JSON.stringify({ ...request, message: 'different' }) + '\n')).error, /reused/)
  assert.match((await raw(target.socket, '{bad}\n')).error, /malformed/)
  assert.match((await raw(target.socket, JSON.stringify({ ...request, messageId: 'large', message: 'a'.repeat(65537) }) + '\n')).error, /64 KiB/)
  assert.match((await raw(target.socket, JSON.stringify({ ...request, instance: 'stale' }) + '\n')).error, /changed/)
  await assert.rejects(a.send({ to: 'b', message: {} }), /text/)
  await assert.rejects(a.send({ to: 'b', message: 'x'.repeat(65537) }), /64 KiB/)
})

test('separate process receives messages and crashed ownership is reclaimed', async t => {
  const { directory, make } = await fixture(t)
  const module = new URL('../src/peers.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createPeers } from ${JSON.stringify(module)};
    const peer = createPeers({ directory: ${JSON.stringify(directory)}, onMessage: value => console.log(JSON.stringify(value)) });
    await peer.connect({ id: 'child', name: 'library', cwd: '/library' });
    console.log('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve() })
    child.on('error', reject)
    child.on('exit', code => reject(new Error(`child exited ${code}`)))
  })
  const parent = make()
  await connect(parent, 'parent')
  assert.equal((await parent.send({ to: 'library', message: 'upstream issue' })).status, 'delivered')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const replacement = make()
  await connect(replacement, 'child', 'library')
  assert.equal((await parent.list()).peers[0].name, 'library')
})

test('receiver rejection is reported as failed, never delivered', async t => {
  const { make } = await fixture(t)
  const events = []
  const a = make({ onSend: message => events.push(message), onDelivery: event => events.push(event) })
  const b = make({ onMessage: async () => { throw new Error('inbox is full') } })
  await connect(a, 'a'); await connect(b, 'b')
  await assert.rejects(a.send({ to: 'b', message: 'hello' }), /inbox is full/)
  assert.equal(events.length, 2)
  assert.equal(events[1].status, 'failed')
})

test('shutdown waits for accepted persistence', async t => {
  const { make } = await fixture(t)
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const a = make(), b = make({ onMessage: async () => { started(); await new Promise(resolve => { release = resolve }) } })
  await connect(a, 'a'); await connect(b, 'b')
  const sent = a.send({ to: 'b', message: 'persist before shutdown' }).catch(error => error)
  await ready
  let stopped = false
  const stopping = b.disconnect().then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(stopped, false)
  release()
  await stopping
  await sent
})

test('status and identities are bounded, and rename retains live status', async t => {
  const { make } = await fixture(t)
  const a = make()
  await connect(a, 'a')
  assert.throws(() => a.setStatus(1n), /status/)
  a.setStatus('busy')
  await connect(a, 'a', 'renamed')
  assert.equal(a.identity.status, 'busy')
  await assert.rejects(a.connect({ id: 'a', name: 'renamed', cwd: 'x'.repeat(5000) }), /working directory/)
})

test('escaped messages within the advertised size limit are deliverable', async t => {
  const { make } = await fixture(t)
  const a = make(), b = make()
  await connect(a, 'a'); await connect(b, 'b')
  assert.equal((await a.send({ to: 'b', message: '\0'.repeat(65536) })).status, 'delivered')
})

test('peer envelopes contain no urgency field', async t => {
  const { make } = await fixture(t)
  const received = []
  const a = make(), b = make({ onMessage: value => received.push(value) })
  await connect(a, 'a'); await connect(b, 'b')
  const sent = await a.send({ to: 'b', message: 'update' })
  assert.equal(received.length, 1)
  assert.equal('urgent' in sent, false)
  assert.equal('urgent' in received[0], false)
})
