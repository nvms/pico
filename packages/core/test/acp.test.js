import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createPeer } from '../src/acp/rpc.js'
import { connectAgent, serveAgent } from '../src/acp/connect.js'
import { createAcpEngine } from '../src/acp/engine.js'
import { allowOption, chosenOption, modelsOffered, picoContent, questionOf, thoughtValue, toolOf, usageOf, acpUsage } from '../src/acp/translate.js'
import { fingerprint, seedText } from '../src/engine-history.js'
import { createRecorder } from '../src/tools/recorder.js'

const CONFIG = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [{ options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] }] },
  { id: 'thinking_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
]

test('two peers ask and answer each other, and a refusal arrives as an error', async () => {
  let a, b
  a = createPeer({ write: (m) => queueMicrotask(() => b.receive(m)), onRequest: (method, params) => ({ echoed: params.x }) })
  b = createPeer({ write: (m) => queueMicrotask(() => a.receive(m)), onRequest: () => { throw Object.assign(new Error('no'), { code: -32000 }) } })
  assert.deepEqual(await b.request('echo', { x: 1 }), { echoed: 1 })
  await assert.rejects(a.request('anything'), (error) => error.code === -32000 && error.message === 'no')
})

test('an agent pico implements is the same over a stream as in this process', async () => {
  const createAgent = (client) => ({
    handle: async (method, params) => { client.notify('session/update', { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: params.say } } }); return { stopReason: 'end_turn' } },
  })
  const heard = []
  const local = connectAgent(createAgent, { onNotification: (method, params) => heard.push(params.update.content.text) })
  assert.deepEqual(await local.request('session/prompt', { say: 'here' }), { stopReason: 'end_turn' })

  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const served = serveAgent(createAgent, { input: toAgent, output: fromAgent })
  const client = createPeer({ write: (m) => toAgent.write(`${JSON.stringify(m)}\n`), onNotification: (method, params) => heard.push(params.update.content.text) })
  fromAgent.on('data', (chunk) => { for (const line of String(chunk).split('\n').filter(Boolean)) client.receive(JSON.parse(line)) })
  assert.deepEqual(await client.request('session/prompt', { say: 'there' }), { stopReason: 'end_turn' })
  assert.deepEqual(heard, ['here', 'there'])
  toAgent.end()
  await served
})

test('models come from the session\'s options, grouped or not', () => {
  assert.deepEqual(modelsOffered(CONFIG), [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { id: 'gemini-4-argon', label: 'Gemini 4 Argon' }])
})

test('pico\'s effort picks the thinking level of that name, or the nearest one, or the agent\'s own choice', () => {
  assert.equal(thoughtValue(CONFIG, 'high'), 'high')
  assert.equal(thoughtValue(CONFIG, 'max'), 'high')
  assert.equal(thoughtValue(CONFIG, 'medium'), 'high')
  assert.equal(thoughtValue(CONFIG, 'auto'), null)
  assert.equal(thoughtValue([{ ...CONFIG[1], options: [{ value: 'auto' }, { value: 'low' }] }], 'auto'), 'auto')
  assert.equal(thoughtValue([], 'high'), null)
})

test('a tool call renders as the pico tool its adapter names, else as its ACP kind says', () => {
  assert.deepEqual(toolOf({ kind: 'execute', rawInput: { command: 'ls' }, _meta: { pico: { tool: { name: 'bash', args: { command: 'ls -la' } }, bridged: false } } }), { name: 'bash', args: { command: 'ls -la' } })
  assert.deepEqual(toolOf({ kind: 'edit', locations: [{ path: '/p/a.js' }] }, '/p'), { name: 'edit', args: { path: 'a.js' } })
  assert.deepEqual(toolOf({ kind: 'execute', rawInput: { command: 'ls' } }), { name: 'bash', args: { command: 'ls' } })
  assert.deepEqual(toolOf({ title: 'peer_send', rawInput: { to: 'x' }, _meta: { pico: { tool: { name: 'peer_send', args: { to: 'x' } }, bridged: true } } }), { name: 'peer_send', args: { to: 'x' }, bridged: true })
})

test('usage counts every input token, and thinking as output, both ways', () => {
  const pico = usageOf({ inputTokens: 10, cachedReadTokens: 90, outputTokens: 5, thoughtTokens: 20 })
  assert.deepEqual(pico, { promptTokens: 100, completionTokens: 25, totalTokens: 125, cachedTokens: 90, thoughtTokens: 20 })
  assert.deepEqual(acpUsage(pico), { inputTokens: 10, cachedReadTokens: 90, outputTokens: 5, thoughtTokens: 20, totalTokens: 125 })
})

test('ACP content becomes a pico message', () => {
  assert.equal(picoContent([{ type: 'text', text: 'hi' }]), 'hi')
  assert.deepEqual(picoContent([{ type: 'text', text: 'see' }, { type: 'image', data: 'AA', mimeType: 'image/png' }]), [{ type: 'text', text: 'see' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AA' } }])
})

test('a permission is allowed once, and a question goes to the person', () => {
  const options = [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }, { optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'aa', name: 'Always', kind: 'allow_always' }]
  assert.equal(allowOption(options).optionId, 'a')
  const asked = { toolCall: { toolCallId: 'q1', rawInput: { Question: 'Which port?' } }, options: [{ optionId: 'p1', name: '3000' }, { optionId: 'p2', name: '30001' }] }
  assert.deepEqual(questionOf(asked), { id: 'answer', question: 'Which port?', type: 'single', options: [{ label: '3000' }, { label: '30001' }], allowOther: false })
  assert.equal(chosenOption({ answer: '30001' }, asked.options).optionId, 'p2')
})

// a scripted ACP agent: each prompt plays the next script, a list of steps
// that are updates to send, or functions given the connection to act on it
function fakeAgent(scripts = [], { signIn = true, fork = false } = {}) {
  const spawned = []
  function connect(options) {
    const proc = { options, requests: [], notified: [], alive: true, config: structuredClone(CONFIG) }
    spawned.push(proc)
    let n = 0
    const update = (sessionId, u) => options.onNotification('session/update', { sessionId, update: u })
    Object.assign(proc, {
      update,
      async request(method, params) {
        proc.requests.push({ method, params })
        if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, ...(fork ? { fork: {} } : {}) } } }
        if (method === 'session/new') {
          if (!signIn) throw Object.assign(new Error('Authentication required'), { code: -32000 })
          return { sessionId: `s${spawned.length}-${++n}`, configOptions: structuredClone(proc.config) }
        }
        if (method === 'session/resume') return { configOptions: structuredClone(proc.config) }
        if (method === 'session/fork') return { sessionId: `fork-of-${params.sessionId}`, configOptions: structuredClone(proc.config) }
        if (method === 'session/set_config_option') { proc.config = proc.config.map((o) => (o.id === params.configId ? { ...o, currentValue: params.value } : o)); return { configOptions: structuredClone(proc.config) } }
        if (method === 'session/prompt') {
          const script = scripts.shift() ?? []
          for (const step of script) {
            await new Promise((resolve) => setTimeout(resolve, 1))
            if (typeof step === 'function') { const out = await step(proc, params.sessionId); if (out?.stopReason) return out }
            else update(params.sessionId, step)
          }
          return { stopReason: 'end_turn', usage: { inputTokens: 10, cachedReadTokens: 90, outputTokens: 5, thoughtTokens: 2 } }
        }
        return null
      },
      notify(method, params) { proc.notified.push({ method, params }) },
      close() { proc.alive = false },
    })
    return proc
  }
  return { connect, spawned }
}

const fakeBridge = () => {
  const bridge = { server: () => ({ name: 'pico', command: 'node', args: ['bridge.js'], env: { PICO_BRIDGE_SOCKET: '/s' } }), setTurn(tools, claim) { bridge.tools = tools; bridge.claim = claim }, close: async () => {} }
  return bridge
}

const engineFor = (connect, bridge = async () => fakeBridge()) => createAcpEngine({ provider: 'agent', label: 'The agent', connect, systemPrompt: () => 'the host note', bridge })

const say = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

async function turn(engine, history, { recorder = createRecorder(), ...extra } = {}) {
  const events = []
  const result = await engine.run({ history, tools: [], recorder, modelName: 'agent/gemini-4-argon', effort: 'high', onStream: (event) => events.push(event), host: { sessionId: 'pico-1', cwd: '/p', env: {} }, ...extra })
  return { result, events, recorder }
}

const methods = (proc) => proc.requests.map((r) => r.method)

test('a turn streams, runs tools, and returns pico history', async (t) => {
  const { connect, spawned } = fakeAgent([[
    say('Looking.'),
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { output: 'a.txt' } },
    say('One file.'),
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())

  const { result, events, recorder } = await turn(engine, [{ role: 'user', content: 'what is here?' }])
  const proc = spawned[0]
  const created = proc.requests.find((r) => r.method === 'session/new').params
  assert.deepEqual(created.mcpServers, [{ name: 'pico', command: 'node', args: ['bridge.js'], env: [{ name: 'PICO_BRIDGE_SOCKET', value: '/s' }] }])
  assert.equal(created._meta.pico.systemPrompt, 'the host note')
  assert.deepEqual(proc.requests.filter((r) => r.method === 'session/set_config_option').map((r) => [r.params.configId, r.params.value]), [['model', 'gemini-4-argon'], ['thinking_level', 'high']])
  assert.deepEqual(proc.requests.find((r) => r.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'what is here?' }])
  assert.deepEqual(events.map((e) => e.type).filter((type) => type !== 'usage'), ['content', 'tool_calls_ready', 'tool_executing', 'tool_complete', 'content'])
  assert.deepEqual(result.messages, [
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'a.txt' },
    { role: 'assistant', content: 'One file.' },
  ])
  assert.equal(recorder.entries[0].callId, 't1')
  assert.equal(recorder.entries[0].fullOutput, 'a.txt')
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 7, totalTokens: 107, cachedTokens: 90, thoughtTokens: 2 })
  assert.equal(result.interrupted, false)
  assert.equal(result.engineState.sessionId, 's1-1')
})

test('an edit keeps its diff and what rewind needs to undo it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pico-agy-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'alpha\nbeta\n')
  const { connect } = fakeAgent([[
    { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Running replace_file_content', kind: 'edit', status: 'in_progress', locations: [{ path: file }] },
    () => writeFileSync(file, 'alpha\nBETA\n'),
    { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [{ type: 'diff', path: file, oldText: 'beta', newText: 'BETA' }] },
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const { recorder } = await turn(engine, [{ role: 'user', content: 'shout beta' }], { host: { sessionId: 'pico-1', cwd: dir, env: {} } })
  const [entry] = recorder.entries
  assert.equal(entry.name, 'edit')
  assert.equal(entry.diff.path, 'a.txt')
  assert.deepEqual([entry.diff.additions, entry.diff.deletions], [1, 1])
  assert.equal(entry.revert.path, file)
  assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA\n')
})

test('the next turn sends only what is new to the same session', async (t) => {
  const { connect, spawned } = fakeAgent([[say('Hi.')], [say('Still here.')]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const first = [{ role: 'user', content: 'hello' }]
  const { result } = await turn(engine, first)
  await turn(engine, [...first, ...result.messages, { role: 'user', content: '[system notification] a shell exited' }, { role: 'user', content: 'again' }])
  assert.equal(spawned.length, 1)
  const prompts = spawned[0].requests.filter((r) => r.method === 'session/prompt')
  assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: '[system notification] a shell exited' }, { type: 'text', text: 'again' }])
  assert.equal(methods(spawned[0]).filter((m) => m === 'session/set_config_option').length, 2, 'the model and level were set once')
})

test('a history the agent has not seen starts a new session seeded with it', async (t) => {
  const { connect, spawned } = fakeAgent([[say('Hi.')], [say('Fresh.')]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  await turn(engine, [{ role: 'user', content: 'hello' }])
  await turn(engine, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Something else.' }, { role: 'user', content: 'go on' }])
  assert.equal(spawned.length, 2)
  assert.equal(spawned[0].alive, false)
  const [seed, input] = spawned[1].requests.find((r) => r.method === 'session/prompt').params.prompt
  assert.equal(seed.text, seedText([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Something else.' }], 'The agent'))
  assert.deepEqual(input, { type: 'text', text: 'go on' })
})

test('a restarted host resumes the saved session; a forked pico session starts its own where the agent cannot fork', async (t) => {
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi.' }]
  const saved = { sessionId: 'saved', owner: 'pico-1', synced: fingerprint(history) }
  const { connect, spawned } = fakeAgent([[say('Back.')], [say('Forked.')]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const next = [...history, { role: 'user', content: 'continue' }]
  const { result } = await turn(engine, next, { host: { sessionId: 'pico-1', cwd: '/p', env: {}, engineState: saved } })
  assert.equal(spawned[0].requests.find((r) => r.method === 'session/resume').params.sessionId, 'saved')
  assert.deepEqual(spawned[0].requests.find((r) => r.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'continue' }])
  assert.equal(result.engineState.sessionId, 'saved')
  await turn(engine, next, { host: { sessionId: 'pico-2', cwd: '/p', env: {}, engineState: saved } })
  assert.ok(!methods(spawned[1]).includes('session/resume'))
  assert.equal(spawned[1].requests.find((r) => r.method === 'session/prompt').params.prompt.length, 2)
})

test('a question reaches the person through ask_user, and a permission is allowed', async (t) => {
  const answers = []
  const { connect } = fakeAgent([[
    async (proc, sessionId) => answers.push(await proc.options.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 'interaction_1', title: 'Which port?' }, options: [{ optionId: 'a', name: '3000' }, { optionId: 'b', name: '8080' }], _meta: { pico: { question: true } } })),
    async (proc, sessionId) => answers.push(await proc.options.onRequest('session/request_permission', { sessionId, toolCall: { toolCallId: 't2', title: 'Run run_command?' }, options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }] })),
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const asked = []
  const askUser = { name: 'ask_user', execute: async ({ questions }) => { asked.push(questions[0]); return { answer: '8080' } } }
  await turn(engine, [{ role: 'user', content: 'start it' }], { tools: [askUser] })
  assert.equal(asked[0].question, 'Which port?')
  assert.deepEqual(answers, [{ outcome: { outcome: 'selected', optionId: 'b' } }, { outcome: { outcome: 'selected', optionId: 'yes' } }])
})

test('a call through the bridge lands on the call the agent announced for it', async (t) => {
  let bridge
  const recorder = createRecorder()
  const claimed = []
  const { connect } = fakeAgent([[
    // agy runs the call over MCP a moment before it announces it
    async (proc, sessionId) => {
      const claim = bridge.claim('peer_send', { to: 'x' }).then(() => claimed.push(recorder.currentCall))
      await new Promise((resolve) => setTimeout(resolve, 5))
      proc.update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'm1', title: 'peer_send', kind: 'other', status: 'in_progress', rawInput: { to: 'x' }, _meta: { pico: { tool: { name: 'peer_send', args: { to: 'x' } }, bridged: true } } })
      await claim
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'm1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'sent' } }] },
  ]])
  const engine = engineFor(connect, async () => (bridge = fakeBridge()))
  t.after(() => engine.releaseAll())
  const tools = [{ name: 'peer_send', execute: async () => 'sent' }, { name: 'bash', execute: async () => '' }]
  const { result } = await turn(engine, [{ role: 'user', content: 'tell x' }], { tools, recorder })
  assert.deepEqual(bridge.tools.map((tool) => tool.name), ['peer_send'])
  assert.deepEqual(claimed, [{ id: 'm1' }])
  assert.equal(result.messages.find((m) => m.role === 'tool').content, 'sent')
})

test('an interrupt cancels the turn and closes calls left open', async (t) => {
  const controller = new AbortController()
  const { connect, spawned } = fakeAgent([[
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Running run_command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 100' } },
    () => controller.abort(),
    async (proc) => { while (!proc.notified.length) await new Promise((resolve) => setTimeout(resolve, 1)); return { stopReason: 'cancelled' } },
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const { result } = await turn(engine, [{ role: 'user', content: 'wait' }], { signal: controller.signal })
  assert.equal(spawned[0].notified[0].method, 'session/cancel')
  assert.equal(result.interrupted, true)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.messages.at(-1), { role: 'tool', tool_call_id: 't1', content: '[interrupted before it finished]' })
})

test('a machine not signed in says so', async (t) => {
  const { connect } = fakeAgent([], { signIn: false })
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const { result } = await turn(engine, [{ role: 'user', content: 'hi' }])
  assert.equal(result.error, 'The agent is not signed in on this machine')
  assert.equal(result.interrupted, true)
})

test('a forked pico session forks the saved session where the agent can', async (t) => {
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi.' }]
  const saved = { sessionId: 'saved', owner: 'pico-1', synced: fingerprint(history) }
  const { connect, spawned } = fakeAgent([[say('Forked.')]], { fork: true })
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const { result } = await turn(engine, [...history, { role: 'user', content: 'go on' }], { host: { sessionId: 'pico-2', cwd: '/p', env: {}, engineState: saved } })
  assert.equal(spawned[0].requests.find((r) => r.method === 'session/fork').params.sessionId, 'saved')
  assert.deepEqual(spawned[0].requests.find((r) => r.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'go on' }])
  assert.equal(result.engineState.sessionId, 'fork-of-saved')
})

test('a subagent\'s traffic reaches its own activity, not the session', async (t) => {
  const { connect } = fakeAgent([[
    { sessionUpdate: 'tool_call', toolCallId: 'a1', title: 'research', kind: 'other', status: 'in_progress', _meta: { pico: { tool: { name: 'Task', args: { description: 'research' } }, subagent: { description: 'research', prompt: 'look' } } } },
    { sessionUpdate: 'tool_call', toolCallId: 'b1', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' }, _meta: { pico: { parentToolCallId: 'a1' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }], _meta: { pico: { parentToolCallId: 'a1' } } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one file' }, _meta: { pico: { parentToolCallId: 'a1' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'framed: one file' } }] },
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const tracked = []
  const subagents = { start(options) { const agent = { options, events: [], finished: null }; tracked.push(agent); return { event: (e) => agent.events.push(e), finish: (r) => { agent.finished = r } } } }
  const { result } = await turn(engine, [{ role: 'user', content: 'look into it' }], { host: { sessionId: 'pico-1', cwd: '/p', env: {}, subagents } })
  assert.equal(tracked[0].options.model, 'agent/gemini-4-argon')
  assert.deepEqual(tracked[0].events.map((e) => e.type), ['tool_executing', 'tool_complete', 'content'])
  assert.deepEqual(tracked[0].finished, { result: 'one file' })
  assert.ok(!result.messages.some((m) => m.tool_calls?.some((c) => c.id === 'b1')))
})

test('an edit the adapter reports whole is shown and can be undone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pico-acp-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'b.txt')
  const { connect } = fakeAgent([[
    { sessionUpdate: 'tool_call', toolCallId: 'w1', kind: 'edit', status: 'in_progress', locations: [{ path: file }], _meta: { pico: { tool: { name: 'write', args: { path: 'b.txt' } } } } },
    () => writeFileSync(file, 'new\n'),
    { sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed', content: [{ type: 'diff', path: file, oldText: null, newText: 'new\n' }], _meta: { pico: { wholeFile: true } } },
  ]])
  const engine = engineFor(connect)
  t.after(() => engine.releaseAll())
  const { recorder } = await turn(engine, [{ role: 'user', content: 'make b' }], { host: { sessionId: 'pico-1', cwd: dir, env: {} } })
  const [entry] = recorder.entries
  assert.equal(entry.created, true)
  assert.equal(entry.revert.before.exists, false)
  assert.equal(entry.diff.additions, 1)
})
