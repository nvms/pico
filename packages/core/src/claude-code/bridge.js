// pico's own tools (peers, questions, wake-ups, and whatever the host adds,
// like kagent's terminals and browser) offered to Claude Code over MCP.
// Claude Code starts mcp-server.js as a stdio MCP server; that process
// relays each list and call over a private Unix socket back to this one,
// where the tool runs with the live turn's toolset and recorder. The tool
// set changes turn to turn, so the bridge holds whichever turn is current.

import { createServer } from 'node:net'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BRIDGE_SERVER, inputSchema } from './translate.js'

const SHIM = fileURLToPath(new URL('./mcp-server.js', import.meta.url))

export async function createBridge() {
  const dir = await mkdtemp(join(tmpdir(), 'pico-claude-'))
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
    // the MCP server entry Claude Code is started with
    mcpConfig() {
      return { mcpServers: { [BRIDGE_SERVER]: { type: 'stdio', command: process.execPath, args: [SHIM], env: { PICO_BRIDGE_SOCKET: path, PICO_BRIDGE_TOKEN: token } } } }
    },
    // the tools a turn offers; `onClaim` ties an incoming call to the
    // tool_use Claude announced for it
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
