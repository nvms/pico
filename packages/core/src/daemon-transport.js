import net from 'node:net'
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import lockfile from 'proper-lockfile'
import { picoHome } from './paths.js'
import { wire } from './daemon-wire.js'
import { createDaemonRuntime } from './daemon-runtime.js'

export function daemonPaths(home = picoHome()) {
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 20)
  const directory = join(tmpdir(), `pico-${process.getuid?.() ?? 'user'}-${hash}`)
  return { directory, socket: join(directory, 'daemon.sock') }
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('unsafe daemon directory')
  await chmod(directory, 0o700)
}
export async function connectDaemon({ socket: path = daemonPaths().socket } = {}) {
  const socket = net.createConnection(path)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const pending = new Map()
  const listeners = new Set()
  let sequence = 0
  const send = wire(socket, message => {
    if (message.type === 'reply') {
      const waiter = pending.get(message.request)
      if (!waiter) return
      pending.delete(message.request)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.value)
    } else for (const listener of listeners) listener(message)
  })
  socket.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('daemon disconnected; running work was not restarted'))
    pending.clear()
    for (const listener of listeners) listener({ type: 'disconnect' })
  })
  return {
    request(op, id, args = []) {
      const result = new Promise((resolve, reject) => {
        if (socket.destroyed) return reject(new Error('daemon disconnected'))
        const request = ++sequence
        pending.set(request, { resolve, reject })
        send({ request, op, id, args })
      })
      result.catch(() => {})
      return result
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    close() { socket.end() },
  }
}
export async function ensureDaemon({ entry, paths = daemonPaths(), startupTimeout = 30000, env = process.env } = {}) {
  await privateDirectory(paths.directory)
  try { return await connectDaemon(paths) } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
  const release = await lockfile.lock(paths.directory, { realpath: false, stale: 60000, retries: { retries: 350, minTimeout: 20, maxTimeout: 100 } })
  try {
    try { return await connectDaemon(paths) } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
    if (!entry) throw new Error('daemon entry is required for automatic startup')
    await unlink(paths.socket).catch(error => { if (error.code !== 'ENOENT') throw error })
    const child = spawn(process.execPath, [entry, '--socket', paths.socket], { detached: true, stdio: 'ignore', env })
    child.unref()
    let failure
    child.once('error', error => { failure = error })
    child.once('exit', code => { failure = new Error(`daemon startup failed (${code})`) })
    const deadline = Date.now() + startupTimeout
    while (Date.now() < deadline) {
      if (failure) throw failure
      try { return await connectDaemon(paths) } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    child.kill('SIGTERM')
    throw new Error('daemon startup timed out')
  } finally { await release() }
}

export async function serveDaemon({ paths = daemonPaths(), createSession, idleMs = 1000, onClose = () => {} }) {
  await privateDirectory(paths.directory)
  const clients = new Set()
  let closing = false
  let idle
  const scheduleIdle = () => {
    if (closing) return
    clearTimeout(idle)
    idle = setTimeout(async () => {
      const rows = await runtime.dispatch(null, { op: 'list' }).catch(() => [])
      if (!rows.length) await close()
    }, idleMs)
  }
  const runtime = createDaemonRuntime({ createSession, onEmpty: scheduleIdle })
  const server = net.createServer(socket => {
    clearTimeout(idle)
    const client = { send: null, socket }
    clients.add(client)
    client.send = wire(socket, message => {
      runtime.dispatch(client, message).then(value => client.send({ type: 'reply', request: message.request, value }), error => client.send({ type: 'reply', request: message.request, error: error.message }))
    })
    socket.once('close', () => { clients.delete(client); runtime.disconnect(client).finally(scheduleIdle) })
    scheduleIdle()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve) })
  await chmod(paths.socket, 0o600)
  scheduleIdle()
  async function close() {
    if (closing) return
    closing = true
    clearTimeout(idle)
    for (const client of clients) client.socket.destroy()
    await runtime.close()
    await new Promise(resolve => server.close(resolve))
    await unlink(paths.socket).catch(error => { if (error.code !== 'ENOENT') throw error })
    onClose()
  }
  return { close, runtime }
}
