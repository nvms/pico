import { readFile, writeFile } from 'node:fs/promises'
import { connectMCP } from '@prsm/ai'
import { globalMcpFile, projectMcpFile, projectDir, ensureDir, picoHome } from './paths.js'
import { dirname } from 'node:path'
import { authProvider, signIn as browserSignIn, signOut as forgetSignIn, hasSignIn } from './mcp-auth.js'

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
  if (!/^https?:\/\//.test(tokens[0] || '')) return { type: 'stdio', ...parseCommand(str) }

  const [url, ...rest] = tokens
  const headers = {}
  for (const token of rest) {
    const sep = token.indexOf('=')
    if (sep < 1) throw new Error(`http server spec only takes a url and Header=value pairs, got "${token}"`)
    headers[token.slice(0, sep)] = token.slice(sep + 1)
  }
  return { type: 'http', url, headers }
}

export const REDACTED_HEADER = '••••••••'

export function isSensitiveHeader(name) {
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|token|secret)$/i.test(name)
}

function quoteHeaderValue(value) {
  if (!/[\s'"\\]/.test(value)) return value
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  throw new Error('header values cannot contain both single and double quotes')
}

export function formatHttpServerSpec(url, headers) {
  const values = Object.entries(headers).map(([name, value]) => `${name}=${quoteHeaderValue(value)}`)
  return [url, ...values].join(' ')
}

export function redactServerSpec(command) {
  let spec
  try {
    spec = parseServerSpec(command)
  } catch {
    return command
  }
  if (spec.type !== 'http') return command
  const headers = Object.fromEntries(Object.entries(spec.headers).map(([name, value]) => [name, isSensitiveHeader(name) ? REDACTED_HEADER : value]))
  return formatHttpServerSpec(spec.url, headers)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch {
    return fallback
  }
}

// the global file: every project's servers, and the ones switched off
// everywhere unless a project switches them back on
export async function readRegistry() {
  const registry = await readJson(globalMcpFile(), {})
  return { servers: registry.servers || {}, disabled: registry.disabled || {} }
}

export async function writeRegistry(registry) {
  ensureDir(picoHome())
  await writeFile(globalMcpFile(), JSON.stringify(registry, null, 2) + '\n')
}

// a project's file: its own servers, and a switch per server where the
// project differs from the global setting (true off, false on)
export async function readProjectConfig(root) {
  const config = await readJson(projectMcpFile(root), {})
  return { disabled: config.disabled || {}, servers: config.servers || {} }
}

export async function writeProjectConfig(root, config) {
  ensureDir(dirname(projectMcpFile(root)))
  await writeFile(projectMcpFile(root), JSON.stringify(config, null, 2) + '\n')
}

export async function createMcpTransport(command) {
  const spec = parseServerSpec(command)
  if (spec.type === 'http') {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    // the server's own address is not listened to for pushed messages;
    // other GETs, like discovering how to sign in, go through
    const fetch = (url, init) => init?.method === 'GET' && String(url) === new URL(spec.url).href
      ? Promise.resolve(new Response(null, { status: 405 }))
      : globalThis.fetch(url, init)
    // a server given its own Authorization header signs in with that
    const ownAuth = Object.keys(spec.headers).some((name) => name.toLowerCase() === 'authorization')
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: Object.keys(spec.headers).length ? { headers: spec.headers } : undefined,
      fetch,
      ...(ownAuth ? {} : { authProvider: authProvider(spec.url) }),
    })
  }
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    stderr: 'pipe',
  })
}

export async function createMcpRuntime({ root, onChange = () => {} }) {
  let registry = await readRegistry()
  let projectConfig = await readProjectConfig(root)
  const servers = new Map()
  // switches for this session alone, never written anywhere
  const sessionSettings = new Map()

  const projectSetting = (name) => (Object.hasOwn(projectConfig.disabled, name) ? !projectConfig.disabled[name] : null)
  const globalEnabled = (name) => !registry.disabled[name]
  // the session's switch wins, then the project's, then the global one
  const effective = (name) => sessionSettings.has(name) ? sessionSettings.get(name) : projectSetting(name) ?? globalEnabled(name)

  const register = (name, command, scope) => {
    const enabled = effective(name)
    servers.set(name, { name, command, scope, enabled, status: enabled ? 'idle' : 'disabled', error: null, connection: null, transport: null })
  }
  for (const [name, command] of Object.entries(registry.servers)) register(name, command, 'global')
  for (const [name, command] of Object.entries(projectConfig.servers)) register(name, command, 'project')

  async function connect(name) {
    const server = servers.get(name)
    if (!server) return
    server.status = 'connecting'
    server.error = null
    onChange()
    try {
      const transport = await createMcpTransport(server.command)
      server.transport = transport
      const connection = await connectMCP({
        name,
        transport: () => transport,
      })
      // switched off or replaced while it was connecting
      if (servers.get(name) !== server || !server.enabled || server.transport !== transport) {
        await connection.close().catch(() => {})
        return
      }
      server.connection = connection
      server.status = 'connected'
    } catch (err) {
      if (servers.get(name) !== server || !server.enabled) return
      // the server wants the person to sign in, which they start themselves
      const signIn = err?.name === 'UnauthorizedError' || err?.constructor?.name === 'UnauthorizedError'
      server.status = signIn ? 'signin' : 'error'
      server.error = signIn ? null : String(err.message || err).slice(0, 300)
      server.connection = null
      server.transport = null
    }
    onChange()
  }

  async function disconnect(name) {
    const server = servers.get(name)
    if (!server) return
    const connection = server.connection
    server.connection = null
    server.transport = null
    if (connection) await connection.close().catch(() => {})
  }

  // brings one server in line with its switches; connecting and closing
  // run in the background, so nothing waits on a slow server
  function apply(name) {
    const server = servers.get(name)
    if (!server) return
    const enabled = effective(name)
    if (enabled === server.enabled && (enabled ? server.status !== 'disabled' : true)) return
    server.enabled = enabled
    if (enabled) connect(name).catch(() => {})
    else {
      server.status = 'disabled'
      server.error = null
      disconnect(name).catch(() => {})
    }
    onChange()
  }

  return {
    connectAll() {
      const pending = []
      for (const server of servers.values()) {
        if (server.enabled) pending.push(connect(server.name))
      }
      return Promise.allSettled(pending)
    },
    // reads both files again and follows them: servers added, removed or
    // changed elsewhere, and switches flipped in another session
    async sync() {
      registry = await readRegistry()
      projectConfig = await readProjectConfig(root)
      const wanted = new Map([
        ...Object.entries(registry.servers).map(([name, command]) => [name, { command, scope: 'global' }]),
        ...Object.entries(projectConfig.servers).map(([name, command]) => [name, { command, scope: 'project' }]),
      ])
      for (const name of [...servers.keys()]) {
        if (wanted.has(name)) continue
        disconnect(name).catch(() => {})
        servers.delete(name)
      }
      for (const [name, { command, scope }] of wanted) {
        const server = servers.get(name)
        if (!server) {
          register(name, command, scope)
          if (servers.get(name).enabled) connect(name).catch(() => {})
          continue
        }
        server.scope = scope
        if (server.command !== command) {
          server.command = command
          disconnect(name).catch(() => {})
          server.status = server.enabled ? 'idle' : 'disabled'
          if (server.enabled) connect(name).catch(() => {})
        }
        apply(name)
      }
      onChange()
    },
    // on or off for this session only; null follows the project and global
    setSessionEnabled(name, enabled) {
      if (enabled === null || enabled === undefined) sessionSettings.delete(name)
      else sessionSettings.set(name, !!enabled)
      apply(name)
    },
    async add(name, command, scope = 'global') {
      if (scope === 'project') {
        const config = await readProjectConfig(root)
        config.servers[name] = command
        await writeProjectConfig(root, config)
        projectConfig = config
      } else {
        const next = await readRegistry()
        next.servers[name] = command
        await writeRegistry(next)
        registry = next
      }
      register(name, command, scope)
      if (servers.get(name).enabled) await connect(name)
      else onChange()
    },
    async update(name, command) {
      const server = servers.get(name)
      if (!server) return
      if (server.scope === 'project') {
        const config = await readProjectConfig(root)
        config.servers[name] = command
        await writeProjectConfig(root, config)
        projectConfig = config
      } else {
        const next = await readRegistry()
        next.servers[name] = command
        await writeRegistry(next)
        registry = next
      }
      await disconnect(name)
      server.command = command
      server.status = server.enabled ? 'idle' : 'disabled'
      server.error = null
      onChange()
      if (server.enabled) await connect(name)
    },
    async remove(name) {
      const scope = servers.get(name)?.scope
      if (scope === 'project') {
        const config = await readProjectConfig(root)
        delete config.servers[name]
        await writeProjectConfig(root, config)
        projectConfig = config
      } else {
        const next = await readRegistry()
        delete next.servers[name]
        delete next.disabled[name]
        await writeRegistry(next)
        registry = next
      }
      await disconnect(name)
      servers.delete(name)
      onChange()
    },
    // the project's switch: off here, or back to on (overriding a global off)
    async toggle(name) {
      const server = servers.get(name)
      if (!server) return
      const config = await readProjectConfig(root)
      if (server.enabled) config.disabled[name] = true
      else if (globalEnabled(name)) delete config.disabled[name]
      else config.disabled[name] = false
      await writeProjectConfig(root, config)
      projectConfig = config
      sessionSettings.delete(name)
      apply(name)
    },
    reconnect(name) {
      return disconnect(name).then(() => connect(name))
    },
    // a browser sign-in to a server that asks for one; open is handed the
    // address to send the person to, the default browser when left out
    async signIn(name, { open } = {}) {
      const server = servers.get(name)
      if (!server) throw new Error(`no MCP server ${name}`)
      const spec = parseServerSpec(server.command)
      if (spec.type !== 'http') throw new Error(`${name} runs on this computer and has no sign-in`)
      await browserSignIn(spec.url, open ? { open } : {})
      await disconnect(name)
      await connect(name)
    },
    async signOut(name) {
      const server = servers.get(name)
      if (!server) return
      const spec = parseServerSpec(server.command)
      if (spec.type === 'http') forgetSignIn(spec.url)
      await disconnect(name)
      await connect(name)
    },
    list() {
      return [...servers.values()].map((s) => ({
        name: s.name,
        command: s.command,
        scope: s.scope,
        enabled: s.enabled,
        globalEnabled: globalEnabled(s.name),
        projectEnabled: projectSetting(s.name),
        sessionEnabled: sessionSettings.has(s.name) ? sessionSettings.get(s.name) : null,
        status: s.status,
        error: s.error,
        signedIn: (() => { const spec = parseServerSpec(s.command); return spec.type === 'http' && hasSignIn(spec.url) })(),
        toolCount: s.connection?.tools.length || 0,
        tools: (s.connection?.tools || []).map((t) => ({ name: t.name, description: t.description || '', schema: t.schema ?? null })),
      }))
    },
    tools() {
      return [...servers.values()]
        .filter((s) => s.connection && s.enabled)
        .flatMap((s) => s.connection.tools)
    },
    closeAll() {
      return Promise.allSettled([...servers.keys()].map(disconnect))
    },
    terminateAll() {
      for (const server of servers.values()) {
        const pid = server.transport?.pid
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {}
        }
      }
    },
  }
}
