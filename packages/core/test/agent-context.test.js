import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentContext } from '../src/agent-context.js'
import { createContextTracker } from '../src/context.js'
import { createToolset } from '../src/tools/index.js'

function tool(name) {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => name }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pico-agent-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const startup = join(root, 'AGENTS.md')
  const nested = join(root, 'docs', 'AGENTS.md')
  await mkdir(join(root, 'docs'))
  await writeFile(nested, 'Documentation instructions')
  const skills = {
    list: () => [{ name: 'humanizer', description: 'Global writing skill' }, { name: 'project-style', description: 'Project writing skill' }],
    load: async () => 'Skill body',
  }
  const memory = {
    list: async () => [{ name: 'global-memory', scope: 'global', description: 'Global fact' }, { name: 'project-memory', scope: 'project', description: 'Project fact' }],
    recall: async () => ({ content: 'Remembered fact' }),
    remember: async () => ({}),
  }
  return {
    root, cwd: root, env: {}, skills, memory,
    startupContext: { stopDir: root, files: [{ path: startup, content: 'Root instructions' }] },
    tracker: createContextTracker({ stopDir: root, loaded: new Set([startup, nested]) }),
    hostTools: [tool('sibling_processes'), tool('schedule'), tool('browser_open'), tool('browser_read')],
    mcp: { tools: () => [tool('mcp_search')] },
  }
}

test('isolated agents receive skill and memory indexes, inherited instructions and independent tracking', async (t) => {
  const boot = await fixture(t)
  const context = await createAgentContext(boot, { isolated: true, instructions: 'Worker role' })
  for (const text of ['humanizer', 'project-style', 'global-memory', 'project-memory', 'Root instructions', 'Documentation instructions', 'Worker role']) {
    assert.ok(context.system.includes(text), text)
  }
  assert.notEqual(context.tools.tracker, boot.tracker)
  assert.deepEqual(context.tools.tracker.loaded, boot.tracker.loaded)
  await mkdir(join(boot.root, 'other'))
  await writeFile(join(boot.root, 'other', 'AGENTS.md'), 'Other instructions')
  assert.equal(context.tools.tracker.check(join(boot.root, 'other', 'file.js')).length, 1)
  assert.equal(boot.tracker.check(join(boot.root, 'other', 'file.js')).length, 1)
})

test('workers receive custom, MCP, memory, skill and non-browser host tools', async (t) => {
  const boot = await fixture(t)
  const context = await createAgentContext(boot, { isolated: true, userTools: [tool('custom_check')] })
  const { tools } = createToolset(context.tools)
  const names = tools.map((entry) => entry.name)
  for (const name of ['skill', 'recall', 'remember', 'custom_check', 'mcp_search', 'sibling_processes', 'schedule']) assert.ok(names.includes(name), name)
  for (const name of ['browser_open', 'browser_read', 'agent_start', 'deliberate', 'ask_user']) assert.ok(!names.includes(name), name)
  assert.deepEqual(await tools.find((entry) => entry.name === 'skill').execute({ name: 'humanizer' }), { instructions: 'Skill body' })
  assert.deepEqual(await tools.find((entry) => entry.name === 'recall').execute({ name: 'global-memory' }), { content: 'Remembered fact' })
  assert.equal(await tools.find((entry) => entry.name === 'mcp_search').execute({}), 'mcp_search')
  assert.equal(await tools.find((entry) => entry.name === 'sibling_processes').execute({}), 'sibling_processes')
  assert.equal(context.tools.skills, boot.skills)
  assert.equal(context.tools.memory, boot.memory)
  const restricted = createToolset({ ...context.tools, allowNames: ['skill', 'browser_open'] })
  assert.deepEqual(restricted.tools.map((entry) => entry.name), ['skill'])
  assert.deepEqual(createToolset({ ...context.tools, allowNames: [] }).tools, [])
})

test('main agent retains browser tools and its tracker', async (t) => {
  const boot = await fixture(t)
  const context = await createAgentContext(boot)
  assert.equal(context.tools.tracker, boot.tracker)
  assert.ok(context.tools.hostTools.some((entry) => entry.name === 'browser_open'))
})

test('unreadable inherited instructions are not marked as delivered', async (t) => {
  const boot = await fixture(t)
  const missing = join(boot.root, 'missing', 'AGENTS.md')
  boot.tracker.loaded.add(missing)
  const context = await createAgentContext(boot, { isolated: true })
  assert.ok(!context.tools.tracker.loaded.has(missing))
})
