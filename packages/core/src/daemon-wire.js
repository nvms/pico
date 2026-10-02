import { serialize, deserialize } from 'node:v8'

export function plain(value, seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return undefined
  seen.add(value)
  let result
  if (value instanceof Map) result = new Map([...value].map(([k, v]) => [plain(k, seen), plain(v, seen)]))
  else if (value instanceof Set) result = new Set([...value].map(v => plain(v, seen)))
  else if (Buffer.isBuffer(value)) result = value
  else if (Array.isArray(value)) result = value.map(v => plain(v, seen))
  else { result = {}; for (const [k, v] of Object.entries(value)) { const next = plain(v, seen); if (next !== undefined) result[k] = next } }
  seen.delete(value)
  return result
}

export function wire(socket, receive, fail = () => {}) {
  const limit = 64 * 1024 * 1024
  let buffer = Buffer.alloc(0)
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0)
        if (size > limit) throw new Error('daemon frame exceeds limit')
        if (buffer.length < size + 4) break
        const message = deserialize(buffer.subarray(4, size + 4))
        buffer = buffer.subarray(size + 4)
        receive(message)
      }
    } catch (error) { fail(error); socket.destroy() }
  })
  socket.on('error', fail)
  return message => {
    const body = serialize(plain(message))
    if (body.length > limit || socket.writableLength > limit) { socket.destroy(); return false }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    socket.write(Buffer.concat([header, body]))
    return true
  }
}
