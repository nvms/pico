// The three ways pico meets an ACP agent, all giving the same connection:
// { request, notify, close, alive, stderr }.
//
// An agent pico implements itself (an adapter, such as Claude Code's, or
// pico's own) is a function `createAgent(client, { exit })`: `client`
// is how it reports (`notify`) and asks (`request`) the side using it,
// and `exit(error)` says it has stopped on its own. It returns
// `{ handle(method, params), notification(method, params), close() }`.
//
// - connectAgent runs such an agent in this process.
// - spawnAgent starts a program that speaks ACP on stdin and stdout.
// - serveAgent offers such an agent to an ACP app over a pair of streams.

import { spawn } from 'node:child_process'
import { streamPeer } from './rpc.js'

const reported = (error) => (error ? Object.assign(new Error(String(error.message || error)), { code: error.code ?? -32603, ...(error.data !== undefined ? { data: error.data } : {}) }) : error)

export function connectAgent(createAgent, { onNotification = () => {}, onRequest = async () => null, onExit = () => {} } = {}) {
  let alive = true
  const finish = (error = null) => {
    if (!alive) return
    alive = false
    onExit({ error, stderr: '' })
  }
  const agent = createAgent({
    notify: (method, params = {}) => { if (alive) onNotification(method, params) },
    request: (method, params = {}) => (alive ? onRequest(method, params) : Promise.reject(new Error('the client has gone'))),
  }, { exit: finish })
  return {
    get alive() { return alive },
    get stderr() { return agent.stderr ?? '' },
    request: async (method, params = {}) => {
      if (!alive) throw new Error('the agent has stopped')
      try { return (await agent.handle(method, params)) ?? null } catch (error) { throw reported(error) }
    },
    notify: (method, params = {}) => { if (alive) agent.notification?.(method, params) },
    close() {
      if (!alive) return
      agent.close?.()
      finish(null)
    },
  }
}

export function spawnAgent({ command, args = [], cwd, env = process.env, onNotification, onRequest, onExit = () => {}, missing = `${command} not found` }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  let alive = true
  const peer = streamPeer({ input: child.stdout, output: child.stdin, onNotification, onRequest })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  child.stdin.on('error', () => {})
  const finish = (error) => {
    if (!alive) return
    alive = false
    peer.close(error ?? new Error(`${command} stopped`))
    onExit({ error, stderr: stderr.trim() })
  }
  child.on('error', (error) => finish(error.code === 'ENOENT' ? new Error(missing) : error))
  child.on('exit', (code, signal) => finish(code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL' ? null : new Error(`${command} exited with ${signal ?? `code ${code}`}`)))
  return {
    get alive() { return alive },
    get stderr() { return stderr.trim() },
    request: (method, params = {}) => (alive ? peer.request(method, params) : Promise.reject(new Error(`${command} is not running`))),
    notify: (method, params = {}) => { if (alive) peer.notify(method, params) },
    close() {
      if (!alive) return
      child.stdin.end()
      child.kill('SIGTERM')
      setTimeout(() => { if (alive) child.kill('SIGKILL') }, 3000).unref()
    },
  }
}

// resolves once the app has gone (its input ended) and the agent has closed
export function serveAgent(createAgent, { input = process.stdin, output = process.stdout } = {}) {
  let agent = null
  const peer = streamPeer({
    input,
    output,
    onRequest: (method, params) => agent.handle(method, params),
    onNotification: (method, params) => agent.notification?.(method, params),
  })
  return new Promise((resolve) => {
    let ended = false
    const done = async () => {
      if (ended) return
      ended = true
      peer.close()
      await agent?.close?.()
      resolve()
    }
    agent = createAgent({ notify: peer.notify, request: peer.request }, { exit: done })
    input.on('end', done)
    input.on('close', done)
  })
}

// the handshake every connection starts with. The agent uses its own tools
// for files and commands, so pico offers it neither
export function initialize(conn) {
  return conn.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'pico', title: 'pico', version: '1' },
  })
}
