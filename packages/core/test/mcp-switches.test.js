import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMcpRuntime, readRegistry, writeRegistry, readProjectConfig, writeProjectConfig } from '../src/mcp.js'

// a server that exits at once: enough to see which servers a runtime tries
const dead = 'node -e process.exit(1)'

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pico-mcp-'))
  const previous = process.env.PICO_HOME
  process.env.PICO_HOME = join(dir, 'home')
  t.after(async () => {
    if (previous === undefined) delete process.env.PICO_HOME
    else process.env.PICO_HOME = previous
    await rm(dir, { recursive: true, force: true })
  })
  return join(dir, 'project')
}

const state = (runtime, name) => runtime.list().find((s) => s.name === name)

test('a session switch beats the project, which beats the global setting', async (t) => {
  const root = await home(t)
  await writeRegistry({ servers: { a: dead, b: dead }, disabled: { a: true } })
  await writeProjectConfig(root, { servers: {}, disabled: { b: true } })
  const runtime = await createMcpRuntime({ root })
  assert.equal(state(runtime, 'a').enabled, false)
  assert.equal(state(runtime, 'b').enabled, false)
  assert.equal(state(runtime, 'a').globalEnabled, false)
  assert.equal(state(runtime, 'b').projectEnabled, false)

  await runtime.toggle('a')
  assert.equal(state(runtime, 'a').enabled, true)
  assert.equal((await readProjectConfig(root)).disabled.a, false)

  runtime.setSessionEnabled('a', false)
  assert.equal(state(runtime, 'a').enabled, false)
  assert.equal(state(runtime, 'a').sessionEnabled, false)
  runtime.setSessionEnabled('a', null)
  assert.equal(state(runtime, 'a').enabled, true)
  runtime.closeAll()
})

test('sync follows servers and switches changed by someone else', async (t) => {
  const root = await home(t)
  await writeRegistry({ servers: { a: dead }, disabled: {} })
  const runtime = await createMcpRuntime({ root })
  const registry = await readRegistry()
  registry.servers.c = dead
  registry.disabled.a = true
  delete registry.servers.missing
  await writeRegistry(registry)
  await writeProjectConfig(root, { servers: { p: dead }, disabled: {} })
  await runtime.sync()
  assert.deepEqual(runtime.list().map((s) => [s.name, s.scope, s.enabled]).sort(), [['a', 'global', false], ['c', 'global', true], ['p', 'project', true]])
  await writeRegistry({ servers: { c: dead }, disabled: {} })
  await runtime.sync()
  assert.deepEqual(runtime.list().map((s) => s.name).sort(), ['c', 'p'])
  runtime.closeAll()
})
