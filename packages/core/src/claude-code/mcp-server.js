// The stdio MCP server Claude Code starts for pico's tools. It holds no
// tools itself: every list and call goes over the socket named in its
// environment to the bridge in the pico process (see bridge.js).

import { createConnection } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const socket = createConnection(process.env.PICO_BRIDGE_SOCKET)
socket.setEncoding('utf8')
socket.write(`${JSON.stringify({ token: process.env.PICO_BRIDGE_TOKEN })}\n`)

const waiting = new Map()
let seq = 0
let buffer = ''
const server = new Server({ name: 'pico', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })

socket.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    if (message.event === 'changed') server.sendToolListChanged().catch(() => {})
    else waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  }
})
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(0))

function ask(message) {
  const id = ++seq
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    socket.write(`${JSON.stringify({ id, ...message })}\n`)
  })
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await ask({ op: 'list' })).tools ?? [] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const reply = await ask({ op: 'call', name: request.params.name, args: request.params.arguments ?? {} })
  if (reply.error) return { content: [{ type: 'text', text: reply.error }], isError: true }
  return { content: [{ type: 'text', text: reply.result }] }
})

await server.connect(new StdioServerTransport())
