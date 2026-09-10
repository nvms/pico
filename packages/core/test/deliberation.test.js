import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeliberation, validateDeliberation } from '../src/deliberation.js'
import { createToolset } from '../src/tools/index.js'

test('deliberation starts in parallel then exchanges sequentially with private histories', async () => {
  const calls = []
  const events = []
  const result = await runDeliberation({
    brief: 'choose an architecture',
    rounds: 2,
    runParticipant: async ({ role, round, history }) => {
      calls.push({ role, round, history })
      return { messages: [{ role: 'assistant', content: `${role}-${round}` }] }
    },
    runSynthesis: async ({ history }) => {
      assert.match(history[0].content, /participant-a-1/)
      assert.match(history[0].content, /participant-b-2/)
      return { messages: [{ role: 'assistant', content: 'decision' }] }
    },
    onEvent: (event) => events.push(event),
  })

  assert.deepEqual(calls.map(({ role, round }) => [role, round]), [
    ['participant-a', 1],
    ['participant-b', 1],
    ['participant-a', 2],
    ['participant-b', 2],
  ])
  assert.match(calls[2].history.map((message) => message.content).join('\n'), /participant-a-1/)
  assert.match(calls[2].history.map((message) => message.content).join('\n'), /participant-b-1/)
  assert.equal(events.length, 4)
  assert.deepEqual(events.slice(0, 2).map(({ parallelGroup }) => parallelGroup), ['initial', 'initial'])
  assert.deepEqual(events.slice(2).map(({ parallelGroup }) => parallelGroup), [undefined, undefined])
  assert.equal(result.result, 'decision')
})

test('deliberation validates its brief and bound', () => {
  assert.throws(() => validateDeliberation({ brief: '' }), /brief is required/)
  assert.throws(() => validateDeliberation({ brief: 'x', rounds: 6 }), /between 1 and 5/)
  assert.equal(validateDeliberation({ brief: ' x ' }).rounds, 3)
})

test('deliberation tool delegates without agent planning', async () => {
  let received
  const deliberations = { run: async (options) => { received = options; return { synthesis: 'done' } } }
  const { tools } = createToolset({
    cwd: process.cwd(),
    deliberations,
    sessionId: 'session-1',
    sessionFile: '/tmp/session.jsonl',
    allowNames: ['deliberate'],
  })
  const tool = tools.find(({ name }) => name === 'deliberate')
  assert.deepEqual(await tool.execute({ brief: 'decide', rounds: 2 }), { synthesis: 'done' })
  assert.equal(received.sessionId, 'session-1')
  assert.equal(received.rounds, 2)
})

test('deliberation stops after a participant failure', async () => {
  const result = await runDeliberation({
    brief: 'choose',
    rounds: 2,
    runParticipant: async () => ({ messages: [], error: 'failed' }),
    runSynthesis: async () => assert.fail('synthesis should not run'),
  })
  assert.equal(result.error, 'failed')
  assert.equal(result.interrupted, true)
})

test('both initial calls start before either finishes and the exchange waits for both', async () => {
  const pending = new Map()
  const calls = []
  const events = []
  const running = runDeliberation({
    brief: 'independent decision', rounds: 2,
    runParticipant: ({ role, round, history }) => {
      calls.push({ role, round, history })
      if (round === 1) return new Promise((resolve) => pending.set(role, resolve))
      return Promise.resolve({ messages: [{ role: 'assistant', content: `${role} revision` }] })
    },
    runSynthesis: async () => ({ messages: [{ role: 'assistant', content: 'result' }] }),
    onEvent: (event) => events.push(event),
  })
  assert.equal(pending.size, 2)
  assert.ok(calls.every(({ history }) => history.length === 1))
  pending.get('participant-b')({ messages: [{ role: 'assistant', content: 'B independent' }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(events.length, 1)
  pending.get('participant-a')({ messages: [{ role: 'assistant', content: 'A independent' }] })
  const result = await running
  assert.deepEqual(result.turns.map(({ role }) => role), ['participant-a', 'participant-b', 'participant-a', 'participant-b'])
  assert.match(calls[3].history.map((message) => message.content).join('\n'), /A independent/)
  assert.match(calls[2].history.map((message) => message.content).join('\n'), /B independent/)
})

test('a failed initial result cancels and joins the other participant', async () => {
  let cancelled = false
  const result = await runDeliberation({
    brief: 'choose', rounds: 1,
    runParticipant: async ({ role, signal }) => {
      if (role === 'participant-a') return { error: 'research failed', messages: [] }
      await new Promise((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      return { interrupted: true, messages: [] }
    },
    runSynthesis: async () => assert.fail('synthesis must not run'),
  })
  assert.equal(cancelled, true)
  assert.equal(result.error, 'research failed')
})

test('one round consists of two independent judgments and synthesis only', async () => {
  const calls = []
  await runDeliberation({
    brief: 'choose', rounds: 1,
    runParticipant: async ({ role, round }) => {
      calls.push([role, round])
      return { messages: [{ role: 'assistant', content: role }] }
    },
    runSynthesis: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }),
  })
  assert.deepEqual(calls, [['participant-a', 1], ['participant-b', 1]])
})
