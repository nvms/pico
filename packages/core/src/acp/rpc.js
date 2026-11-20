// JSON-RPC 2.0 as the Agent Client Protocol (ACP) uses it: one message per
// line, either side may ask the other and be asked. A peer is the same
// whichever side it is on; what it does with what it is asked is its own.

import { createInterface } from 'node:readline'

export class RpcError extends Error {
  constructor(message, code = -32603, data = undefined) {
    super(message)
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export const methodNotFound = (method) => new RpcError(`${method} is not handled here`, -32601)

// a peer that sends with `write(message)` and is handed what arrives with
// `receive(message)`. `onRequest(method, params)` answers what the other
// side asks; `onNotification(method, params)` hears what it reports
export function createPeer({ write, onRequest = (method) => { throw methodNotFound(method) }, onNotification = () => {} }) {
  const pending = new Map()
  let seq = 0
  let closed = null

  async function answer(message) {
    try {
      const result = await onRequest(message.method, message.params ?? {})
      write({ jsonrpc: '2.0', id: message.id, result: result ?? null })
    } catch (error) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: String(error.message || error), ...(error.data !== undefined ? { data: error.data } : {}) } })
    }
  }

  return {
    receive(message) {
      if (message.method && message.id !== undefined) { answer(message); return }
      if (message.method) { onNotification(message.method, message.params ?? {}); return }
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (!waiter) return
      if (message.error) waiter.reject(new RpcError(message.error.message || 'request refused', message.error.code, message.error.data))
      else waiter.resolve(message.result ?? null)
    },
    request(method, params = {}) {
      if (closed) return Promise.reject(closed)
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params = {}) {
      if (!closed) write({ jsonrpc: '2.0', method, params })
    },
    // the other side is gone: whatever was asked of it fails
    close(error = new Error('the other side stopped')) {
      if (closed) return
      closed = error
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    },
  }
}

// a peer over a pair of streams, one JSON message per line; a line that is
// not JSON (a program's stray output) is ignored
export function streamPeer({ input, output, ...handlers }) {
  const peer = createPeer({ ...handlers, write: (message) => { if (output.writable) output.write(`${JSON.stringify(message)}\n`) } })
  createInterface({ input }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message && typeof message === 'object') peer.receive(message)
  })
  return peer
}
