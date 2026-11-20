import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectAgent } from '../src/acp/connect.js'
import { createPicoAgent, kindOf, sessionServers } from '../src/acp/pico-agent.js'
import { createRecorder } from '../src/tools/recorder.js'

const MODELS = [
  { name: 'codex/gpt-6-luna', label: 'GPT-6 Luna', provider: 'codex', context: 400000, effort: true },
  { name: 'claude-code/haiku', label: 'Haiku (Claude Code)', provider: 'claude-code', context: 1000000, effort: true },
  { name: 'openai/gpt-x', label: 'GPT-X', provider: 'openai', available: false },
]

// a scripted pico session: `send` plays the next turn, a function given
// the controller and the boot's turn relay
function fakeSessions(turns = []) {
  const opened = []
  const openSession = async ({ cwd, mcpServers, extra }) => {
    const listeners = new Map()
    const emit = (type, value) => { for (const fn of listeners.get(type) ?? []) fn(value) }
    const recorder = createRecorder()
    const ctl = {
      boot: { models: MODELS, root: cwd },
      state: { model: MODELS[0], effort: null, session: null, busy: false, events: [], derived: { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, thoughtTokens: 0 }, lastPromptTokens: 0, transcript: [] } },
      sent: [],
      answers: [],
      shutdowns: 0,
      on(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); return () => {} },
      ensureSession() { ctl.state.session ??= { id: `pico-session-${opened.length}` } },
      effortApplies: () => ctl.state.model.effort === true,
      switchModelByName(name) { ctl.state.model = MODELS.find((m) => m.name === name) },
      setEffortByName(level) { ctl.state.effort = level === 'default' ? null : level },
      isWorking: () => ctl.state.busy,
      attachImage: () => '[Image #1]',
      answerQuestion(answers) { ctl.answers.push(answers) },
      cancelQuestion() { ctl.answers.push(null) },
      interrupt() { ctl.interrupted = true },
      async shutdown() { await new Promise((resolve) => setTimeout(resolve, 5)); ctl.shutdowns++ },
      send(text) {
        ctl.sent.push(text)
        const turn = turns.shift()
        ctl.state.busy = true
        emit('change')
        setTimeout(async () => {
          await turn?.({ ctl, relay: (event) => extra.onTurnEvent(event, recorder), recorder, emit })
          ctl.state.busy = false
          emit('change')
        }, 1)
      },
    }
    opened.push({ ctl, cwd, mcpServers })
    return { controller: ctl, dispose: () => { ctl.disposed = true } }
  }
  return { openSession, opened }
}

function connect(sessions, { onRequest = async () => null } = {}) {
  const updates = []
  const conn = connectAgent((client, control) => createPicoAgent(client, control, { openSession: sessions.openSession, loadRuntime: async () => ({ models: MODELS, providers: ['codex', 'claude-code'] }) }), {
    onNotification: (method, params) => updates.push(params.update ?? params),
    onRequest,
  })
  return { conn, updates }
}

test('pico tools are shown by kind, and an app\'s MCP servers become the session\'s own', () => {
  assert.deepEqual(['bash', 'read', 'edit', 'grep', 'browser_open', 'peer_send'].map(kindOf), ['execute', 'read', 'edit', 'search', 'fetch', 'other'])
  assert.deepEqual(sessionServers([{ name: 'docs', command: 'node', args: ['docs server.js'], env: [{ name: 'KEY', value: 'k' }] }, { type: 'http', name: 'web', url: 'https://w/mcp', headers: [] }]), { docs: 'KEY=k node "docs server.js"', web: 'https://w/mcp' })
})

test('a session offers every model it can run, by provider, and switches between them', async () => {
  const sessions = fakeSessions()
  const { conn } = connect(sessions)
  const hello = await conn.request('initialize', { protocolVersion: 1 })
  assert.deepEqual(hello.authMethods.map((m) => m.id), ['claude-code', 'codex', 'grok', 'antigravity'])
  const { sessionId, configOptions } = await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  assert.equal(sessionId, 'pico-session-1')
  assert.deepEqual(configOptions[0].options.map((g) => [g.group, g.name, g.options.map((o) => o.value)]), [['codex', 'ChatGPT', ['codex/gpt-6-luna']], ['claude-code', 'Claude Code', ['claude-code/haiku']]])
  const next = await conn.request('session/set_config_option', { sessionId, configId: 'model', value: 'claude-code/haiku' })
  assert.equal(next.configOptions[0].currentValue, 'claude-code/haiku')
  const effort = await conn.request('session/set_config_option', { sessionId, configId: 'effort', value: 'high' })
  assert.equal(effort.configOptions[1].currentValue, 'high')
  assert.equal((await conn.request('session/set_config_option', { sessionId, configId: 'effort', value: 'auto' })).configOptions[1].currentValue, 'auto')
})

test('a turn is relayed as it happens and answers with what it used', async () => {
  const sessions = fakeSessions([async ({ ctl, relay, recorder }) => {
    relay({ type: 'thinking', content: 'hmm' })
    relay({ type: 'content', content: 'Writing it.' })
    const call = { id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'hi\n', description: 'Creating a.txt' }) } }
    relay({ type: 'tool_executing', call })
    recorder.entries.push({ callId: 'c1', name: 'write', args: { path: 'a.txt', content: 'hi\n' }, status: 'done', fullOutput: 'ok', created: true })
    relay({ type: 'tool_complete', call, result: 'ok' })
    ctl.state.derived.usage = { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 100, thoughtTokens: 10 }
  }])
  const { conn, updates } = connect(sessions)
  const { sessionId } = await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  const reply = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'make a.txt' }] })
  assert.deepEqual(reply, { stopReason: 'end_turn', usage: { inputTokens: 20, cachedReadTokens: 100, outputTokens: 20, thoughtTokens: 10, totalTokens: 150 } })
  assert.equal(sessions.opened[0].ctl.sent[0], 'make a.txt')
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update'])
  const [, , call, done] = updates
  assert.deepEqual([call.title, call.kind, call.locations], ['Creating a.txt', 'edit', [{ path: '/w/a.txt' }]])
  assert.deepEqual(done.content[1], { type: 'diff', path: '/w/a.txt', oldText: null, newText: 'hi\n' })
})

test('pico\'s question reaches the app as a choice, and a written one is answered as unanswerable', async () => {
  const sessions = fakeSessions([async ({ ctl, emit }) => {
    await new Promise((resolve) => {
      ctl.answerQuestion = (answers) => { ctl.answers.push(answers); resolve() }
      emit('question', { questions: [{ id: 'c', question: 'Which colour?', type: 'single', options: [{ label: 'red' }, { label: 'blue' }] }, { id: 'n', question: 'Your name?', type: 'text' }] })
    })
  }])
  const asked = []
  const { conn } = connect(sessions, { onRequest: async (method, params) => { asked.push(params); return { outcome: { outcome: 'selected', optionId: 'blue' } } } })
  const { sessionId } = await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ask me' }] })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].toolCall.title, 'Which colour?')
  assert.deepEqual(asked[0].options.map((o) => o.name), ['red', 'blue'])
  assert.deepEqual(sessions.opened[0].ctl.answers, [['blue', '(no answer: this app cannot take a written answer)']])
})

test('a cancelled turn interrupts pico and answers cancelled', async () => {
  let finish
  const sessions = fakeSessions([() => new Promise((resolve) => { finish = resolve })])
  const { conn } = connect(sessions)
  const { sessionId } = await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  const reply = conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  conn.notify('session/cancel', { sessionId })
  assert.equal(sessions.opened[0].ctl.interrupted, true)
  finish()
  assert.equal((await reply).stopReason, 'cancelled')
})

test('closing waits for every session to shut down', async () => {
  const sessions = fakeSessions()
  let agent
  const conn = connectAgent((client, control) => (agent = createPicoAgent(client, control, { openSession: sessions.openSession, loadRuntime: async () => ({ models: MODELS, providers: ['codex'] }) })))
  await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  await conn.request('session/new', { cwd: '/w', mcpServers: [] })
  await agent.close()
  assert.deepEqual(sessions.opened.map(({ ctl }) => [ctl.shutdowns, ctl.disposed]), [[1, true], [1, true]])
})
