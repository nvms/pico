import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const example = join(dirname(require.resolve('@modelcontextprotocol/sdk/package.json')), '..', 'esm', 'examples', 'server', 'simpleStreamableHttp.js')
const MCP_PORT = 39411
const AUTH_PORT = 39412

async function until(check, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

test('a server that wants OAuth asks for sign-in, is signed in once, and every later session is let in', { timeout: 60000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pico-oauth-'))
  process.env.PICO_HOME = home
  const server = spawn(process.execPath, [example, '--oauth'], { env: { ...process.env, MCP_PORT: String(MCP_PORT), MCP_AUTH_PORT: String(AUTH_PORT) }, stdio: 'ignore' })
  t.after(async () => { server.kill(); await rm(home, { recursive: true, force: true }) })
  await until(async () => (await fetch(`http://localhost:${AUTH_PORT}/.well-known/oauth-authorization-server`)).ok)

  const { createMcpRuntime } = await import(`../src/mcp.js?${Date.now()}`)
  const root = join(home, 'project')
  await mkdir(root, { recursive: true })
  await writeFile(join(home, 'mcp.json'), JSON.stringify({ servers: { demo: `http://localhost:${MCP_PORT}/mcp` } }))

  const first = await createMcpRuntime({ root })
  await first.connectAll()
  assert.equal(first.list()[0].status, 'signin', JSON.stringify(first.list()[0]))
  assert.equal(first.list()[0].signedIn, false)

  // the demo approves at once, so the browser is a plain request that follows its redirect
  await first.signIn('demo', { open: (url) => fetch(url).then((r) => r.text()) })
  const after = first.list()[0]
  assert.equal(after.status, 'connected', JSON.stringify(after))
  assert.ok(after.toolCount > 0)
  assert.equal(after.signedIn, true)
  await first.closeAll()

  const second = await createMcpRuntime({ root })
  await second.connectAll()
  assert.equal(second.list()[0].status, 'connected')
  await second.closeAll()
})
