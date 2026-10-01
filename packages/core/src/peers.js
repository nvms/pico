import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, createServer } from 'node:net'
import lockfile from 'proper-lockfile'
import { picoHome } from './paths.js'

const VERSION = 1
const MAX_FRAME = 512 * 1024
const MAX_MESSAGE = 64 * 1024
const TIMEOUT = 5000
const MAX_CONNECTIONS = 32
const fail = (message, code = 'PEER_ERROR') => Object.assign(new Error(message), { code })
const messageIdentity = ({ id, name }) => ({ id, name })
const validStatus = status => ['idle', 'busy', 'paused'].includes(status)
const publicIdentity = ({ id, name, cwd, status }) => ({ id, name, cwd, status })

function defaultDirectory() {
  const hash = createHash('sha256').update(picoHome()).digest('hex').slice(0, 12)
  return join('/tmp', `pico-peers-${process.getuid?.() ?? 'user'}-${hash}`)
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

function packet(value) {
  const data = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(data) > MAX_FRAME) throw fail('peer frame exceeds 512 KiB')
  return data
}

function exchange(path, request) {
  const data = packet(request)
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.setEncoding('utf8')
    let buffer = ''
    let settled = false
    let sent = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        error.uncertain = sent && request.type === 'deliver' && error.code !== 'PEER_REJECTED'
        reject(error)
      } else resolve(value)
    }
    const timer = setTimeout(() => finish(fail('peer request timed out')), TIMEOUT)
    socket.on('connect', () => { sent = true; socket.write(data) })
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_FRAME) return finish(fail('peer response exceeds 512 KiB'))
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        if (response.v !== VERSION) return finish(fail('unsupported peer protocol version'))
        if (!response.ok) return finish(fail(response.error || 'peer rejected message', 'PEER_REJECTED'))
        finish(null, response.value)
      } catch { finish(fail('malformed peer response')) }
    })
    socket.on('error', error => finish(error))
    socket.on('end', () => finish(fail('peer closed without a response')))
  })
}

export function createPeers({ directory = defaultDirectory(), onMessage, onSend, onDelivery } = {}) {
  if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function')
  let identity = null
  let server = null
  let operation = Promise.resolve()
  const connections = new Set()
  const deliveries = new Map()
  const activeDeliveries = new Set()
  const registryFile = join(directory, 'registry.json')
  const serialize = task => {
    const result = operation.then(task)
    operation = result.catch(() => {})
    return result
  }

  async function initialize() {
    if (process.platform === 'win32') throw fail('peer messaging requires Unix-domain sockets')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('peer directory must be private and owned by this user')
  }

  async function readRegistry() {
    try {
      const records = JSON.parse(await readFile(registryFile, 'utf8'))
      if (!Array.isArray(records)) throw fail('invalid peer registry')
      return records
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async function updateRegistry(update) {
    await initialize()
    const release = await lockfile.lock(directory, { realpath: false, lockfilePath: join(directory, 'registry.lock'), stale: 5000, update: 1000, retries: { retries: 140, minTimeout: 50, maxTimeout: 50 } })
    try {
      const all = await readRegistry()
      const stale = new Set()
      for (const record of all) {
        if (!processAlive(record.pid)) { stale.add(record); continue }
        try { await exchange(record.socket, { v: VERSION, type: 'ping', to: record.id, instance: record.instance }) } catch (error) {
          if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) stale.add(record)
        }
      }
      const records = all.filter(record => !stale.has(record))
      const result = await update(records)
      const temporary = `${registryFile}.${randomUUID()}`
      try {
        await writeFile(temporary, JSON.stringify(records), { mode: 0o600 })
        await rename(temporary, registryFile)
      } finally { await rm(temporary, { force: true }) }
      for (const record of stale) {
        if (record.socket?.startsWith(`${directory}/s-`) && !records.some(peer => peer.socket === record.socket)) await rm(record.socket, { force: true })
      }
      return result
    } finally { await release() }
  }

  async function receive(request) {
    const self = identity
    if (!self) throw fail('peer session is disconnected')
    if (!request || request.v !== VERSION) throw fail('unsupported peer protocol version')
    if (request.to !== self.id || request.instance !== self.instance) throw fail('peer session changed')
    if (request.type === 'ping') return publicIdentity(self)
    if (request.type !== 'deliver') throw fail('unknown peer request type')
    if (typeof request.messageId !== 'string' || request.messageId.length > 100 || !request.messageId) throw fail('invalid message ID')
    validateMessage(request.message)
    validateUrgency(request.urgent)
    const sender = (await readRegistry()).find(record => record.id === request.fromId && record.instance === request.fromInstance)
    if (!sender || !processAlive(sender.pid)) throw fail('sender is disconnected')
    if (sender.id === self.id) throw fail('cannot message yourself')
    if (identity?.instance !== self.instance) throw fail('peer session changed')
    const envelope = { id: request.messageId, from: messageIdentity(sender), to: messageIdentity(self), message: request.message, urgent: request.urgent ?? false }
    const key = `${sender.instance}:${envelope.id}`
    let delivery = deliveries.get(key)
    if (delivery && (delivery.message !== envelope.message || delivery.urgent !== envelope.urgent)) throw fail('message ID reused with different content')
    if (!delivery) {
      delivery = { message: envelope.message, urgent: envelope.urgent, promise: Promise.resolve().then(() => onMessage(envelope)) }
      deliveries.set(key, delivery)
      activeDeliveries.add(delivery.promise)
    }
    try { await delivery.promise } catch (error) { deliveries.delete(key); throw error } finally { activeDeliveries.delete(delivery.promise) }
    if (deliveries.size > 1024) deliveries.delete(deliveries.keys().next().value)
    return { id: envelope.id, status: 'delivered' }
  }

  function accept(socket) {
    if (connections.size >= MAX_CONNECTIONS) return socket.destroy()
    connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let handled = false
    const timer = setTimeout(() => socket.destroy(), TIMEOUT)
    const respond = (ok, value) => {
      if (socket.destroyed) return
      try { socket.end(packet(ok ? { v: VERSION, ok, value } : { v: VERSION, ok, error: String(value).slice(0, 1000) })) } catch { socket.destroy() }
    }
    socket.on('data', chunk => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_FRAME) { handled = true; respond(false, 'peer frame exceeds 512 KiB'); return }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      handled = true
      clearTimeout(timer)
      let request
      try { request = JSON.parse(buffer.slice(0, end)) } catch { respond(false, 'malformed peer request'); return }
      receive(request).then(value => respond(true, value), error => respond(false, error.message))
    })
    socket.on('close', () => { clearTimeout(timer); connections.delete(socket) })
    socket.on('error', () => {})
  }

  function connect(next) {
    return serialize(async () => {
      await initialize()
      if (!next || typeof next.id !== 'string' || !next.id || next.id.length > 100 || /[\x00-\x20\x7f]/.test(next.id) || typeof next.cwd !== 'string' || next.cwd.length > 4096) throw fail('session ID and working directory are required')
      if (typeof next.name !== 'string' || !next.name.trim() || next.name !== next.name.trim() || next.name.length > 200 || /[\x00-\x1f\x7f]/.test(next.name)) throw fail('peer name must be 1-200 characters without control characters')
      if (identity && identity.id !== next.id) throw fail('disconnect before changing session ID')
      if (next.status !== undefined && !validStatus(next.status)) throw fail('invalid peer status')
      const previous = identity
      const instance = previous?.instance ?? randomUUID()
      const record = { ...next, status: next.status ?? previous?.status ?? 'idle', pid: process.pid, instance, socket: previous?.socket ?? join(directory, `s-${instance.slice(0, 16)}.sock`) }
      if (Buffer.byteLength(record.socket) > 103) throw fail('peer socket path is too long')
      if (!previous) {
        server = createServer(accept)
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(record.socket, resolve) })
      }
      try {
        await updateRegistry(records => {
          if (records.some(peer => peer.id === next.id && peer.instance !== instance)) throw fail(`session ${next.id} is already connected`)
          if (records.some(peer => peer.name === next.name && peer.instance !== instance)) throw fail(`peer name "${next.name}" is already connected`)
          const index = records.findIndex(peer => peer.instance === instance)
          if (index < 0) records.push(record)
          else records[index] = record
        })
        identity = record
        return publicIdentity(record)
      } catch (error) {
        if (!previous) {
          await new Promise(resolve => server.close(resolve))
          server = null
          await rm(record.socket, { force: true })
        }
        throw error
      }
    })
  }

  function disconnect() {
    return serialize(async () => {
      const current = identity
      if (!current) return
      identity = null
      await updateRegistry(records => {
        const index = records.findIndex(peer => peer.instance === current.instance)
        if (index >= 0) records.splice(index, 1)
      }).finally(async () => {
        await Promise.allSettled(activeDeliveries)
        for (const connection of connections) connection.destroy()
        await new Promise(resolve => server.close(resolve))
        server = null
        await rm(current.socket, { force: true })
        deliveries.clear()
      })
    })
  }

  async function list() {
    const self = identity
    if (!self) throw fail('peer session is not connected')
    const records = await readRegistry()
    const peers = []
    for (const record of records) {
      if (record.instance === self.instance || !processAlive(record.pid)) continue
      try { peers.push(await exchange(record.socket, { v: VERSION, type: 'ping', to: record.id, instance: record.instance })) } catch {}
    }
    return { self: publicIdentity(self), peers }
  }

  async function send({ to, message, urgent = false }) {
    const self = identity
    if (!self) throw fail('peer session is not connected')
    if (typeof to !== 'string' || !to) throw fail('message target is required')
    validateMessage(message)
    validateUrgency(urgent)
    const records = await readRegistry()
    const matches = records.filter(record => processAlive(record.pid) && (record.id === to || record.name === to))
    if (!matches.length) throw fail(`peer "${to}" is offline`)
    if (matches.length > 1) throw fail(`peer "${to}" is ambiguous; use a session ID`)
    const peer = matches[0]
    if (peer.id === self.id) throw fail('cannot message yourself')
    const envelope = { id: randomUUID(), from: messageIdentity(self), to: messageIdentity(peer), message, urgent }
    const request = { v: VERSION, type: 'deliver', to: peer.id, instance: peer.instance, fromId: self.id, fromInstance: self.instance, messageId: envelope.id, message, urgent }
    packet(request)
    await onSend?.(envelope)
    try {
      if (identity?.instance !== self.instance) throw fail('sender session changed')
      const receipt = await exchange(peer.socket, request)
      if (receipt.id !== envelope.id || receipt.status !== 'delivered') throw Object.assign(fail('invalid delivery receipt'), { uncertain: true })
    } catch (error) {
      await onDelivery?.({ id: envelope.id, status: error.uncertain ? 'unknown' : 'failed', error: error.message })
      throw error
    }
    await onDelivery?.({ id: envelope.id, status: 'delivered' })
    return { ...envelope, status: 'delivered' }
  }

  function setStatus(status) {
    if (!validStatus(status)) throw fail('invalid peer status')
    if (identity) identity = { ...identity, status }
  }

  return { connect, disconnect, list, send, setStatus, get identity() { return identity && publicIdentity(identity) } }
}

function validateMessage(message) {
  if (typeof message !== 'string' || !message.trim()) throw fail('message must be nonempty text')
  if (Buffer.byteLength(message) > MAX_MESSAGE) throw fail('peer message exceeds 64 KiB')
}

function validateUrgency(urgent) {
  if (urgent !== undefined && typeof urgent !== 'boolean') throw fail('urgent must be a boolean')
}
