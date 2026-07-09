import { readFile, writeFile } from 'node:fs/promises'
import { connectMCP } from '@prsm/ai'
import { globalMcpFile, projectMcpFile, projectDir, ensureDir, picoHome } from './paths.js'

function tokenize(str) {
  const tokens = []
  const re = /([A-Za-z0-9_-]+=)?"([^"]*)"|([A-Za-z0-9_-]+=)?'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(str))) {
    if (m[1] !== undefined || m[3] !== undefined) tokens.push((m[1] ?? m[3]) + (m[2] ?? m[4]))
    else tokens.push(m[2] ?? m[4] ?? m[5])
  }
  return tokens
}

export function parseCommand(str) {
  const tokens = tokenize(str)

  const env = {}
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const sep = tokens[0].indexOf('=')
    env[tokens[0].slice(0, sep)] = tokens[0].slice(sep + 1)
    tokens.shift()
  }
  if (!tokens.length) throw new Error('empty command')
  return { command: tokens[0], args: tokens.slice(1), env }
}

export function parseServerSpec(str) {
  const tokens = tokenize(str)
  const url = tokens.find((t) => /^https?:\/\//.test(t))
  if (!url) return { type: 'stdio', ...parseCommand(str) }

  const headers = {}
  for (const token of tokens) {
    if (token === url) continue
    const sep = token.indexOf('=')
    if (sep < 1) throw new Error(`http server spec only takes a url and Header=value pairs, got "${token}"`)
    headers[token.slice(0, sep)] = token.slice(sep + 1)
  }
  return { type: 'http', url, headers }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch {
    return fallback
  }
}

export function readRegistry() {
  return readJson(globalMcpFile(), { servers: {} })
}

export async function writeRegistry(registry) {
  ensureDir(picoHome())
  await writeFile(globalMcpFile(), JSON.stringify(registry, null, 2) + '\n')
}

export function readEnablement(root) {
  return readJson(projectMcpFile(root), { disabled: {} })
}

export async function writeEnablement(root, enablement) {
  ensureDir(projectDir(root))
  await writeFile(projectMcpFile(root), JSON.stringify(enablement, null, 2) + '\n')
}

export async function createMcpRuntime({ root, onChange = () => {} }) {
  const registry = await readRegistry()
  const enablement = await readEnablement(root)
  const servers = new Map()

  for (const [name, command] of Object.entries(registry.servers)) {
    servers.set(name, {
      name,
      command,
      enabled: !enablement.disabled[name],
      status: enablement.disabled[name] ? 'disabled' : 'idle',
      error: null,
      connection: null,
    })
  }

  async function transportFactory(command) {
    const spec = parseServerSpec(command)
    if (spec.type === 'http') {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      return () =>
        new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: Object.keys(spec.headers).length ? { headers: spec.headers } : undefined,
        })
    }
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return () =>
      new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...process.env, ...spec.env },
        stderr: 'pipe',
      })
  }

  async function connect(name) {
    const server = servers.get(name)
    if (!server) return
    server.status = 'connecting'
    server.error = null
    onChange()
    try {
      server.connection = await connectMCP({
        name,
        transport: await transportFactory(server.command),
      })
      server.status = 'connected'
    } catch (err) {
      server.status = 'error'
      server.error = String(err.message || err).slice(0, 300)
      server.connection = null
    }
    onChange()
  }

  async function disconnect(name) {
    const server = servers.get(name)
    if (server?.connection) {
      await server.connection.close().catch(() => {})
      server.connection = null
    }
  }

  return {
    connectAll() {
      const pending = []
      for (const server of servers.values()) {
        if (server.enabled) pending.push(connect(server.name))
      }
      return Promise.allSettled(pending)
    },
    async add(name, command) {
      const registry = await readRegistry()
      registry.servers[name] = command
      await writeRegistry(registry)
      servers.set(name, { name, command, enabled: true, status: 'idle', error: null, connection: null })
      await connect(name)
    },
    async remove(name) {
      const registry = await readRegistry()
      delete registry.servers[name]
      await writeRegistry(registry)
      await disconnect(name)
      servers.delete(name)
      onChange()
    },
    async toggle(name) {
      const server = servers.get(name)
      if (!server) return
      const enablement = await readEnablement(root)
      if (server.enabled) {
        server.enabled = false
        server.status = 'disabled'
        enablement.disabled[name] = true
        await writeEnablement(root, enablement)
        await disconnect(name)
        onChange()
      } else {
        server.enabled = true
        delete enablement.disabled[name]
        await writeEnablement(root, enablement)
        await connect(name)
      }
    },
    reconnect(name) {
      return disconnect(name).then(() => connect(name))
    },
    list() {
      return [...servers.values()].map((s) => ({
        name: s.name,
        command: s.command,
        enabled: s.enabled,
        status: s.status,
        error: s.error,
        toolCount: s.connection?.tools.length || 0,
        tools: (s.connection?.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
      }))
    },
    tools() {
      return [...servers.values()]
        .filter((s) => s.connection)
        .flatMap((s) => s.connection.tools)
    },
    async closeAll() {
      for (const name of servers.keys()) await disconnect(name)
    },
  }
}
