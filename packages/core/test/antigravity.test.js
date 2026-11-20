import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agyEnv } from '../src/antigravity/process.js'
import { agyModel, antigravityModels, parseModelList } from '../src/antigravity/models.js'
import { connectAntigravity, mcpTool, picoTool } from '../src/antigravity/adapter.js'
import { initialize } from '../src/acp/connect.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))

test('agy never sees an API key, so it runs on the Google sign-in', () => {
  assert.deepEqual(agyEnv({ PATH: '/bin', GEMINI_API_KEY: 'k', GOOGLE_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p', AGY_ADC_AUTH: 'true' }), { PATH: '/bin' })
})

test('models are named by provider and reach agy by id', () => {
  const [model] = antigravityModels([{ id: 'gemini-4-argon', label: 'Gemini 4 Argon' }])
  assert.deepEqual([model.name, model.label, model.provider, model.effort], ['antigravity/gemini-4-argon', 'Gemini 4 Argon (Antigravity)', 'antigravity', true])
  assert.equal(agyModel('antigravity/gemini-4-argon'), 'gemini-4-argon')
  assert.deepEqual(parseModelList('Fetching available models...\n  gemini-3.8-flash   Gemini 3.8 Flash\n- gemini-4-argon (Gemini 4 Argon)\n'), [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { id: 'gemini-4-argon', label: 'Gemini 4 Argon' }])
})

test('agy\'s tool calls are labelled with the pico tools they amount to', () => {
  assert.deepEqual(picoTool({ kind: 'execute', title: 'Running run_command', rawInput: { CommandLine: 'ls', Cwd: '/p/src' } }, '/p'), { tool: { name: 'bash', args: { command: 'ls', cwd: 'src' } } })
  assert.deepEqual(picoTool({ kind: 'edit', title: 'Running replace_file_content', locations: [{ path: '/p/a.js' }] }, '/p'), { tool: { name: 'edit', args: { path: 'a.js' } } })
  assert.deepEqual(picoTool({ kind: 'read', rawInput: { AbsolutePath: '/elsewhere/a.js' } }, '/p'), { tool: { name: 'read', args: { path: '/elsewhere/a.js' } } })
  assert.deepEqual(picoTool({ kind: 'other', title: 'Running start_subagent', rawInput: { Role: 'tester', Prompt: 'run tests' } }), { tool: { name: 'Task', args: { description: 'tester', prompt: 'run tests' } }, subagent: { description: 'tester', prompt: 'run tests' } })
  assert.equal(mcpTool({ title: 'Running pico_peer_send' }, ['pico']), 'peer_send')
  assert.equal(mcpTool({ title: 'Running mcp_pico_ask_user' }, ['pico']), 'ask_user')
  assert.equal(mcpTool({ title: 'Running picture_view' }, ['pico']), null)
})

test('the adapter passes agy through with pico\'s rules applied', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pico-agy-adapter-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logFile = join(dir, 'log')
  const env = { FAKE_AGY_LOG: logFile, GEMINI_HOME: join(dir, 'gemini'), GEMINI_API_KEY: 'would-bill-the-key' }
  // the catalog is kept in this process's pico home
  const home = process.env.PICO_HOME
  process.env.PICO_HOME = join(dir, 'pico')
  t.after(() => { if (home === undefined) delete process.env.PICO_HOME; else process.env.PICO_HOME = home })
  const heard = []
  const conn = connectAntigravity({
    command: FAKE,
    cwd: dir,
    env,
    onNotification: (method, params) => heard.push(params.update),
    onRequest: async (method, params) => ({ outcome: { outcome: 'selected', optionId: params._meta?.pico?.question ? 'a' : 'none' } }),
  })
  t.after(() => conn.close())
  await initialize(conn)
  const session = await conn.request('session/new', { cwd: '/w', mcpServers: [{ name: 'pico', command: 'node', args: [], env: [] }], _meta: { pico: { systemPrompt: 'the host note', ephemeral: true } } })
  await conn.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] })
  await conn.request('session/close', { sessionId: session.sessionId })

  const log = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(log[0], { args: ['acp', '--dangerously-skip-permissions'], apiKey: null })
  assert.deepEqual(log.find((e) => e.method === 'session/new').params._meta, { antigravity: { systemPrompt: { append: 'the host note' } } })
  assert.equal(log.find((e) => 'answered' in e).answered.outcome.optionId, 'a', 'its question is marked as one')
  const [command, output, mcp, read] = heard
  assert.deepEqual(command._meta.pico.tool, { name: 'bash', args: { command: 'ls', cwd: 'src' } })
  assert.deepEqual(output.content, [{ type: 'content', content: { type: 'text', text: 'a.txt' } }])
  assert.deepEqual(mcp._meta.pico, { tool: { name: 'peer_send', args: { to: 'x' } }, bridged: true })
  assert.deepEqual(read.locations, [{ path: '/w/README.md' }])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pico', 'antigravity-models.json'), 'utf8')), [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }])
  assert.ok(!existsSync(join(dir, 'gemini', 'antigravity-cli', 'conversations', `${session.sessionId}.db`)), 'a one-question session leaves nothing in agy\'s history')
})
