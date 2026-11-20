// pico's own tools (peers, questions, wake-ups, and whatever the host adds,
// like kagent's terminals and browser) offered over MCP to a program an
// engine runs, such as Claude Code or Antigravity. The program starts
// tool-bridge-server.js as a stdio MCP server; that process relays each
// list and call over a private Unix socket back to this one, where the
// tool runs with the live turn's toolset and recorder. The tool set
// changes turn to turn, so the bridge holds whichever turn is current.

import { createServer } from 'node:net'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('./tool-bridge-server.js', import.meta.url))

// the MCP server's name, so the program sees pico's tools under it, as
// Claude Code's mcp__pico__<name>
export const BRIDGE_SERVER = 'pico'

// ---- pico tool schemas to JSON Schema ----

function jsonProperty(prop) {
  const out = { type: prop.type }
  if (prop.description) out.description = prop.description
  if (prop.enum) out.enum = prop.enum
  if (prop.items) out.items = jsonProperty(prop.items)
  if (prop.properties) {
    out.properties = Object.fromEntries(Object.entries(prop.properties).map(([key, child]) => [key, jsonProperty(child)]))
    if (prop.required) out.required = prop.required
  }
  return out
}

export function inputSchema(schema = {}) {
  // a whole JSON Schema (an MCP server's) goes as it is
  if (typeof schema.type === 'string') return schema
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(schema)) {
    properties[key] = jsonProperty(prop)
    if (!prop.optional) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

export async function createBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'pico-bridge-'))
  await chmod(dir, 0o700)
  const path = join(dir, 'bridge.sock')
  const token = randomBytes(24).toString('hex')
  const sockets = new Set()
  let tools = []
  let names = ''
  let claim = () => null
  // calls run one at a time: pico's recorder holds one pending call
  let queue = Promise.resolve()

  const server = createServer((socket) => {
    let buffer = ''
    let authed = false
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (!authed) {
          if (message.token !== token) { socket.destroy(); return }
          authed = true
          sockets.add(socket)
          continue
        }
        handle(message).then((reply) => socket.write(`${JSON.stringify({ id: message.id, ...reply })}\n`))
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })

  function list() {
    // always loaded, not deferred behind Claude Code's tool search: they
    // are few, and a deferred tool fails its first call
    return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.schema), _meta: { 'anthropic/alwaysLoad': true } }))
  }

  async function handle(message) {
    if (message.op === 'list') return { tools: list() }
    if (message.op !== 'call') return { error: `unknown operation ${message.op}` }
    const tool = tools.find((t) => t.name === message.name)
    if (!tool) return { error: `no tool named ${message.name}` }
    const run = queue.then(async () => {
      // the recorder files this call under Claude's id for it, so its row
      // and result land on the tool call the transcript already shows
      await claim(message.name, message.args)
      try {
        const result = await tool.execute(message.args ?? {})
        return { result: typeof result === 'string' ? result : JSON.stringify(result ?? null) }
      } catch (error) {
        return { error: String(error.message || error) }
      }
    })
    queue = run.catch(() => {})
    return run
  }

  return {
    // the stdio MCP server the program is started with
    server() {
      return { name: BRIDGE_SERVER, command: process.execPath, args: [SHIM], env: { PICO_BRIDGE_SOCKET: path, PICO_BRIDGE_TOKEN: token } }
    },
    // the tools a turn offers; `onClaim` ties an incoming call to the
    // tool call the program announced for it
    setTurn(next, onClaim) {
      tools = next
      claim = onClaim
      const now = tools.map((t) => t.name).sort().join()
      if (now !== names) {
        names = now
        for (const socket of sockets) socket.write(`${JSON.stringify({ event: 'changed' })}\n`)
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
