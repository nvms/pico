import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeArgs, claudeEnv } from '../src/claude-code/cli.js'
import { cliModel, claudeCodeModels } from '../src/claude-code/models.js'
import { fingerprint, inputSchema, picoTool, seedText, splitTurn, toolEntry, usageOf } from '../src/claude-code/translate.js'
import { createClaudeCodeEngine } from '../src/claude-code/engine.js'
import { createRecorder } from '../src/tools/recorder.js'

test('the child never sees an API key, so it bills the subscription', () => {
  const env = claudeEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1' })
  assert.deepEqual(env, { PATH: '/bin' })
})

test('Claude Code runs without permission prompts and with pico taking questions', () => {
  const args = claudeArgs({ model: 'opus', effort: 'high', resume: 'abc', fork: true })
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'AskUserQuestion,EnterWorktree,ExitWorktree')
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 6), ['--model', 'opus', '--effort', 'high', '--resume', 'abc'])
  assert.ok(args.includes('--fork-session'))
  assert.ok(!claudeArgs({ fork: true }).includes('--fork-session'), 'nothing to fork without a session to resume')
})

test('models are named by provider and reach the CLI by alias', () => {
  const models = claudeCodeModels()
  assert.deepEqual(models.map((m) => m.name), ['claude-code/fable', 'claude-code/opus', 'claude-code/sonnet', 'claude-code/haiku'])
  assert.ok(models.every((m) => m.provider === 'claude-code' && m.effort && m.context === 1000000))
  assert.equal(cliModel('claude-code/opus'), 'opus')
})

test('Claude tools render as the pico tools they correspond to', () => {
  assert.deepEqual(picoTool('Bash', { command: 'ls', description: 'List' }), { name: 'bash', args: { command: 'ls', description: 'List' } })
  assert.deepEqual(picoTool('Edit', { file_path: '/p/src/a.js', old_string: 'a', new_string: 'b' }, '/p'), { name: 'edit', args: { path: 'src/a.js', oldText: 'a', newText: 'b' } })
  assert.deepEqual(picoTool('Read', { file_path: '/elsewhere/a.js' }, '/p'), { name: 'read', args: { path: '/elsewhere/a.js' } })
  assert.deepEqual(picoTool('mcp__pico__peer_send', { to: 'x', message: 'hi' }), { name: 'peer_send', args: { to: 'x', message: 'hi' }, bridged: true })
  assert.deepEqual(picoTool('WebFetch', { url: 'u' }), { name: 'WebFetch', args: { url: 'u' } })
})

test('an edit keeps its diff and what rewind needs to undo it', () => {
  const use = { id: 't1', name: 'Edit', input: { file_path: '/p/a.txt', old_string: 'beta', new_string: 'BETA' } }
  const block = { tool_use_id: 't1', type: 'tool_result', content: 'updated' }
  const extra = { filePath: '/p/a.txt', originalFile: 'alpha\nbeta\n', structuredPatch: [] }
  const entry = toolEntry(use, block, extra, { cwd: '/p', after: 'alpha\nBETA\n' })
  assert.equal(entry.name, 'edit')
  assert.equal(entry.status, 'done')
  assert.equal(entry.diff.path, 'a.txt')
  assert.deepEqual([entry.diff.additions, entry.diff.deletions], [1, 1])
  assert.equal(entry.revert.path, '/p/a.txt')
  assert.deepEqual(entry.revert.splices, [{ start: 6, oldText: 'beta', newText: 'BETA' }])

  const created = toolEntry({ id: 't2', name: 'Write', input: { file_path: '/p/b.txt', content: 'x' } }, { content: 'created' }, { type: 'create', filePath: '/p/b.txt', content: 'x', originalFile: null }, { cwd: '/p' })
  assert.equal(created.created, true)
  assert.equal(created.revert.before.exists, false)
})

test('a bash result shows its output, and an interrupted call is not an error', () => {
  const use = { id: 't1', name: 'Bash', input: { command: 'make' } }
  const done = toolEntry(use, { content: 'ok' }, { stdout: 'ok', stderr: 'warn' })
  assert.equal(done.fullOutput, 'ok\nwarn')
  const cut = toolEntry(use, { content: 'rejected', is_error: true }, null, { interrupted: true })
  assert.equal(cut.status, 'interrupted')
  assert.equal(cut.error, undefined)
})

test('usage counts every input token a request carried', () => {
  assert.deepEqual(usageOf({ input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }), { promptTokens: 112, completionTokens: 5, totalTokens: 117, cachedTokens: 100, thoughtTokens: 0 })
})

test('a turn is what follows the last thing the model said', () => {
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'note' }, { role: 'user', content: 'c' }]
  assert.deepEqual(splitTurn(history), { prior: history.slice(0, 2), input: history.slice(2) })
})

test('the history fingerprint ignores tool results pico later elides or trims', () => {
  const call = { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }
  const before = [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: 'long output' }]
  const after = [before[0], { role: 'tool', tool_call_id: 'c1', content: '[tool result elided]' }]
  assert.equal(fingerprint(before), fingerprint(after))
  assert.notEqual(fingerprint(before), fingerprint([...before, { role: 'user', content: 'x' }]))
})

test('pico tool schemas become JSON Schema for MCP', () => {
  assert.deepEqual(inputSchema({ to: { type: 'string', description: 'who' }, tail: { type: 'number', optional: true } }), {
    type: 'object', properties: { to: { type: 'string', description: 'who' }, tail: { type: 'number' } }, required: ['to'],
  })
})

// ---- the engine against a scripted Claude Code ----

const SESSION = 'claude-session-1'

// a stand-in for one `claude` process: each user message it is sent is
// answered by the next scripted reply
function fakeClaude(replies) {
  const spawned = []
  const spawn = (options) => {
    const proc = { options, sent: [], alive: true }
    spawned.push(proc)
    queueMicrotask(() => options.onMessage({ type: 'system', subtype: 'init', session_id: SESSION }))
    Object.assign(proc, {
      send(content) {
        proc.sent.push(content)
        const reply = replies.shift() ?? []
        setTimeout(() => {
          for (const message of reply) options.onMessage(message)
          options.onMessage({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION })
        }, 1)
        return true
      },
      interrupt: async () => null,
      close() { proc.alive = false },
    })
    return proc
  }
  return { spawn, spawned }
}

const fakeBridge = () => {
  const bridge = { turns: [], mcpConfig: () => ({ mcpServers: {} }), setTurn(tools, claim) { bridge.turns.push(tools); bridge.claim = claim }, close: async () => {} }
  return bridge
}

const text = (id, value) => [
  { type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } },
  { type: 'assistant', message: { id, content: [{ type: 'text', text: value }] } },
]

async function turn(engine, history, extra = {}) {
  const events = []
  const recorder = createRecorder()
  const result = await engine.run({ history, tools: [], recorder, modelName: 'claude-code/opus', effort: 'high', onStream: (event) => events.push(event), host: { sessionId: 'pico-1', cwd: '/p', env: {} }, ...extra })
  return { result, events, recorder }
}

test('a turn streams, runs tools, and returns pico history', async (t) => {
  const bash = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls', description: 'List' } }] } }
  const output = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] }, tool_use_result: { stdout: 'a.txt', stderr: '' } }
  const { spawn, spawned } = fakeClaude([[...text('m1', 'Looking.'), bash, output, ...text('m2', 'One file.')]])
  const engine = createClaudeCodeEngine({ spawn, bridge: async () => fakeBridge() })
  t.after(() => engine.releaseAll())

  const { result, events, recorder } = await turn(engine, [{ role: 'user', content: 'what is here?' }])
  assert.deepEqual(spawned[0].sent, [[{ type: 'text', text: 'what is here?' }]])
  assert.deepEqual(spawned[0].options.model, 'opus')
  assert.deepEqual(events.map((e) => e.type).filter((type) => type !== 'usage'), ['content', 'tool_calls_ready', 'tool_executing', 'tool_complete', 'content'])
  assert.deepEqual(result.messages, [
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls","description":"List"}' } }] },
    { role: 'tool', tool_call_id: 'tu1', content: 'a.txt' },
    { role: 'assistant', content: 'One file.' },
  ])
  assert.equal(recorder.entries[0].callId, 'tu1')
  assert.equal(recorder.entries[0].fullOutput, 'a.txt')
  assert.deepEqual(result.usage, { promptTokens: 200, completionTokens: 14, totalTokens: 214, cachedTokens: 180, thoughtTokens: 0 })
  assert.equal(result.lastPromptTokens, 100)
  assert.equal(result.interrupted, false)
  assert.equal(result.engineState.claudeSessionId, SESSION)
})

test('the next turn sends only what is new to the same process', async (t) => {
  const { spawn, spawned } = fakeClaude([text('m1', 'Hi.'), text('m2', 'Still here.')])
  const engine = createClaudeCodeEngine({ spawn, bridge: async () => fakeBridge() })
  t.after(() => engine.releaseAll())
  const first = [{ role: 'user', content: 'hello' }]
  const { result } = await turn(engine, first)
  await turn(engine, [...first, ...result.messages, { role: 'user', content: '[system notification] a shell exited' }, { role: 'user', content: 'again' }])
  assert.equal(spawned.length, 1)
  assert.deepEqual(spawned[0].sent[1], [{ type: 'text', text: '[system notification] a shell exited' }, { type: 'text', text: 'again' }])
})

test('a history Claude Code has not seen starts a new session seeded with it', async (t) => {
  const { spawn, spawned } = fakeClaude([text('m1', 'Hi.'), text('m2', 'Fresh.')])
  const engine = createClaudeCodeEngine({ spawn, bridge: async () => fakeBridge() })
  t.after(() => engine.releaseAll())
  await turn(engine, [{ role: 'user', content: 'hello' }])
  // the conversation was rewritten under it, as a rewind or steer does
  await turn(engine, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Something else.' }, { role: 'user', content: 'go on' }])
  assert.equal(spawned.length, 2)
  assert.equal(spawned[1].options.resume, null)
  const [seed, input] = spawned[1].sent[0]
  assert.equal(seed.text, seedText([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Something else.' }]))
  assert.deepEqual(input, { type: 'text', text: 'go on' })
})

test('a restarted host resumes the saved Claude session, and a fork forks it', async (t) => {
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi.' }]
  const saved = { claudeSessionId: 'saved', owner: 'pico-1', synced: fingerprint(history) }
  const { spawn, spawned } = fakeClaude([text('m1', 'Back.'), text('m2', 'Forked.')])
  const engine = createClaudeCodeEngine({ spawn, bridge: async () => fakeBridge() })
  t.after(() => engine.releaseAll())
  const next = [...history, { role: 'user', content: 'continue' }]
  await turn(engine, next, { host: { sessionId: 'pico-1', cwd: '/p', env: {}, engineState: saved } })
  assert.equal(spawned[0].options.resume, 'saved')
  assert.equal(spawned[0].options.fork, false)
  assert.deepEqual(spawned[0].sent[0], [{ type: 'text', text: 'continue' }])
  await turn(engine, next, { host: { sessionId: 'pico-2', cwd: '/p', env: {}, engineState: saved } })
  assert.equal(spawned[1].options.resume, 'saved')
  assert.equal(spawned[1].options.fork, true)
})

test('a pico tool called through the bridge is recorded under Claude\'s call id', async (t) => {
  const bridges = []
  const call = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu9', name: 'mcp__pico__peer_send', input: { to: 'b', message: 'hi' } }] } }
  const { spawn } = fakeClaude([])
  const engine = createClaudeCodeEngine({
    spawn: (options) => {
      const proc = spawn(options)
      proc.send = (content) => {
        proc.sent.push(content)
        setTimeout(async () => {
          options.onMessage(call)
          // Claude Code runs the call through the MCP bridge
          const bridge = bridges[0]
          await bridge.claim('peer_send', { to: 'b', message: 'hi' })
          await bridge.turns[0].find((tool) => tool.name === 'peer_send').execute({ to: 'b', message: 'hi' })
          options.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: '{"delivered":true}' }] } })
          options.onMessage({ type: 'result', is_error: false, session_id: SESSION })
        }, 1)
        return true
      }
      return proc
    },
    bridge: async () => { const bridge = fakeBridge(); bridges.push(bridge); return bridge },
  })
  t.after(() => engine.releaseAll())
  const recorder = createRecorder()
  const { recorded } = await import('../src/tools/recorder.js')
  const tools = [
    { name: 'peer_send', description: 'send', schema: {}, execute: recorded(recorder, 'peer_send', async () => ({ delivered: true })) },
    { name: 'bash', description: 'covered by Claude', schema: {}, execute: async () => null },
  ]
  const events = []
  await engine.run({ history: [{ role: 'user', content: 'tell b hi' }], tools, recorder, modelName: 'claude-code/opus', onStream: (e) => events.push(e), host: { sessionId: 'pico-1', cwd: '/p', env: {} } })
  assert.deepEqual(bridges[0].turns[0].map((tool) => tool.name), ['peer_send'], 'tools Claude Code has its own of are not offered')
  assert.equal(recorder.entries.length, 1)
  assert.equal(recorder.entries[0].callId, 'tu9')
  assert.equal(events.find((e) => e.type === 'tool_executing').call.function.name, 'peer_send')
})

test('an interrupted turn closes its open calls so the history stays valid', async (t) => {
  const call = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 9' } }] } }
  const { spawn } = fakeClaude([])
  const controller = new AbortController()
  const engine = createClaudeCodeEngine({
    spawn: (options) => {
      const proc = spawn(options)
      proc.send = () => { setTimeout(() => { options.onMessage(call); controller.abort() }, 1); return true }
      proc.interrupt = async () => { setTimeout(() => options.onMessage({ type: 'result', is_error: false, session_id: SESSION }), 1) }
      return proc
    },
    bridge: async () => fakeBridge(),
  })
  t.after(() => engine.releaseAll())
  const { result } = await turn(engine, [{ role: 'user', content: 'wait' }], { signal: controller.signal })
  assert.equal(result.interrupted, true)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.messages.at(-1), { role: 'tool', tool_call_id: 'tu1', content: '[interrupted before it finished]' })
})

test('a process that cannot start fails the turn with the reason', async (t) => {
  const engine = createClaudeCodeEngine({
    spawn: (options) => {
      setTimeout(() => options.onExit({ error: new Error('claude not found; install Claude Code and sign in with claude auth login') }), 1)
      return { send: () => true, close() {}, interrupt: async () => null }
    },
    bridge: async () => fakeBridge(),
  })
  t.after(() => engine.releaseAll())
  const { result } = await turn(engine, [{ role: 'user', content: 'hi' }])
  assert.match(result.error, /claude not found/)
  assert.equal(result.engineState.claudeSessionId, null)
})
