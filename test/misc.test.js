import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLine, parseLines, makeEvent } from '../src/core/events.js'
import { createMcpTransport, parseCommand, parseServerSpec, redactServerSpec } from '../src/core/mcp.js'
import { parseFrontmatter, createSkillIndex } from '../src/core/skills.js'
import { discoverKeys } from '../src/core/keys.js'
import { defaultModel, estimateCost, findModel } from '../src/core/models.js'
import { extractModels, adhocModel } from '../src/core/catalog.js'
import { fuzzyScore } from '../src/ui/fuzzy.js'

test('parseLine tolerates garbage and blank lines', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('{"broken'), null)
  assert.equal(parseLine('"just a string"'), null)
  assert.equal(parseLine('{"type":"user","data":{}}').type, 'user')
  const events = parseLines('{"type":"a","data":{}}\n\nnot json\n{"type":"b","data":{}}\n')
  assert.equal(events.length, 2)
})

test('events carry ids and timestamps', () => {
  const e = makeEvent('user', { text: 'hi' })
  assert.ok(e.id)
  assert.ok(e.at > 0)
})

test('parseCommand handles quotes and env prefixes', () => {
  assert.deepEqual(parseCommand('npx -y @modelcontextprotocol/server-filesystem /tmp'), {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: {},
  })
  assert.deepEqual(parseCommand('API_KEY=abc node server.js --dir "/my docs"'), {
    command: 'node',
    args: ['server.js', '--dir', '/my docs'],
    env: { API_KEY: 'abc' },
  })
  assert.throws(() => parseCommand('KEY=only'), /empty command/)
})

test('parseServerSpec routes urls to http and commands to stdio', () => {
  assert.deepEqual(parseServerSpec('npx -y @modelcontextprotocol/server-filesystem /tmp'), {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: {},
  })
  assert.deepEqual(parseServerSpec('https://mcp.linear.app/mcp'), {
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: {},
  })
  assert.deepEqual(parseServerSpec('https://mcp.example.com/mcp Authorization="Bearer abc==" X-Team=core'), {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer abc==', 'X-Team': 'core' },
  })
  assert.throws(() => parseServerSpec('https://x.dev extra-token'), /Header=value/)
  assert.deepEqual(parseServerSpec('npx some-server --endpoint https://api.example.com'), {
    type: 'stdio',
    command: 'npx',
    args: ['some-server', '--endpoint', 'https://api.example.com'],
    env: {},
  })
})

test('http MCP transport uses request responses instead of a standalone SSE stream', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(init)
    return new Response(null, { status: 202 })
  }
  try {
    const transport = await createMcpTransport('https://mcp.example.com Authorization="Bearer token"')
    const response = await transport._fetch(new URL('https://mcp.example.com'), { method: 'GET' })
    assert.equal(response.status, 405)
    assert.equal(requests.length, 0)

    await transport._fetch(new URL('https://mcp.example.com'), { method: 'POST' })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('redactServerSpec hides sensitive http headers', () => {
  assert.equal(
    redactServerSpec('https://mcp.example.com/mcp Authorization="Bearer abc==" X-Team=core X-API-Key=secret'),
    'https://mcp.example.com/mcp Authorization=•••••••• X-Team=core X-API-Key=••••••••',
  )
  assert.equal(redactServerSpec('TOKEN=secret node server.js'), 'TOKEN=secret node server.js')
})

test('mcp runtime merges global and project servers, scopes writes', async () => {
  const { createMcpRuntime, writeRegistry, writeProjectConfig, readProjectConfig, readRegistry } = await import('../src/core/mcp.js')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))

  await writeRegistry({ servers: { fs: 'npx -y server-filesystem /tmp', shared: 'global-cmd' } })
  await writeProjectConfig(root, { disabled: { fs: true }, servers: { local: 'node server.js', shared: 'project-cmd' } })

  const mcp = await createMcpRuntime({ root })
  const byName = Object.fromEntries(mcp.list().map((s) => [s.name, s]))
  assert.equal(byName.fs.scope, 'global')
  assert.equal(byName.fs.enabled, false)
  assert.equal(byName.local.scope, 'project')
  assert.equal(byName.shared.scope, 'project')
  assert.equal(byName.shared.command, 'project-cmd')

  await mcp.update('local', 'node changed.js')
  assert.equal((await readProjectConfig(root)).servers.local, 'node changed.js')
  assert.equal(mcp.list().find((s) => s.name === 'local').command, 'node changed.js')

  await mcp.remove('local')
  assert.deepEqual((await readProjectConfig(root)).servers, { shared: 'project-cmd' })
  assert.equal((await readRegistry()).servers.fs, 'npx -y server-filesystem /tmp')
  delete process.env.PICO_HOME
})

test('parseFrontmatter extracts meta and body', () => {
  const { meta, body } = parseFrontmatter('---\nname: deploy\ndescription: ship it\n---\ndo the thing\n')
  assert.equal(meta.name, 'deploy')
  assert.equal(meta.description, 'ship it')
  assert.equal(body.trim(), 'do the thing')
  assert.deepEqual(parseFrontmatter('no frontmatter').meta, {})
})

test('project skills override global skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  process.env.PICO_HOME = home
  await mkdir(join(home, 'skills/deploy'), { recursive: true })
  await writeFile(join(home, 'skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: global deploy\n---\nglobal body')
  await mkdir(join(root, '.pico/skills/deploy'), { recursive: true })
  await writeFile(join(root, '.pico/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: project deploy\n---\nproject body')

  const index = await createSkillIndex(root)
  const deploy = index.list().find((s) => s.name === 'deploy')
  assert.equal(deploy.description, 'project deploy')
  assert.equal((await index.load('deploy')).trim(), 'project body')

  const builtin = index.list().find((s) => s.name === 'new-tool')
  assert.equal(builtin.source, 'builtin')
  assert.match(await index.load('new-tool'), /default export/)
  delete process.env.PICO_HOME
})

test('discoverKeys picks up provider env vars', () => {
  const keys = discoverKeys({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })
  assert.deepEqual(keys, { google: 'g', openai: 'o' })
})

test('extractModels filters, sorts by release, and maps fields', () => {
  const providers = {
    google: {
      models: {
        'gemini-x': { description: 'newest', tool_call: true, reasoning: true, cost: { input: 1, output: 4 }, release_date: '2026-05-01', limit: { context: 1e6, input: 900000 } },
        'gemini-old': { description: 'older', tool_call: true, reasoning: false, release_date: '2025-01-01' },
        'gemini-tts': { description: 'speech', tool_call: false, release_date: '2026-06-01' },
        'gemini-x-20260501': { description: 'dated dupe', tool_call: true, release_date: '2026-05-01' },
      },
    },
    openai: { models: { 'gpt-z': { tool_call: true, name: 'GPT Z', release_date: '2026-01-01' } } },
  }
  const models = extractModels(providers, ['google', 'openai'])
  assert.deepEqual(models.map((m) => m.name), ['google/gemini-x', 'google/gemini-old', 'openai/gpt-z'])
  const [newest, older, gpt] = models
  assert.equal(newest.effort, true)
  assert.deepEqual(newest.price, { in: 1, out: 4 })
  assert.equal(newest.context, 900000)
  assert.equal(older.price, null)
  assert.equal(gpt.desc, 'GPT Z')
  assert.equal(defaultModel(models).name, 'google/gemini-x')
  assert.equal(estimateCost(findModel(models, 'google/gemini-x'), { promptTokens: 1e6, completionTokens: 1e6 }), 5)
  assert.equal(estimateCost(findModel(models, 'google/gemini-old'), { promptTokens: 1e6, completionTokens: 1e6 }), 0)
})

test('adhocModel accepts raw names for live providers only', () => {
  const m = adhocModel('openai/gpt-6-codex', ['google', 'openai'])
  assert.equal(m.provider, 'openai')
  assert.equal(m.price, null)
  assert.equal(m.effort, false)
  assert.equal(adhocModel('mistral/large', ['google', 'openai']), null)
  assert.equal(adhocModel('no-slash', ['google']), null)
})

test('fuzzyScore ranks contiguous and boundary matches higher', () => {
  assert.ok(fuzzyScore('sig', 'src/signal.js') > fuzzyScore('sig', 'src/sxixgx.js'))
  assert.ok(fuzzyScore('', 'anything') === 0)
  assert.equal(fuzzyScore('zzz', 'src/signal.js'), -1)
})
