import test from 'node:test'
import assert from 'node:assert/strict'
import { runDeliberation, validateDeliberation } from '../src/deliberation.js'
import { createToolset } from '../src/tools/index.js'

test('deliberation alternates participants with persistent private histories', async () => {
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
      assert.match(history[0].content, /proposer-1/)
      assert.match(history[0].content, /reviewer-2/)
      return { messages: [{ role: 'assistant', content: 'decision' }] }
    },
    onEvent: (event) => events.push(event),
  })

  assert.deepEqual(calls.map(({ role, round }) => [role, round]), [
    ['proposer', 1],
    ['reviewer', 1],
    ['proposer', 2],
    ['reviewer', 2],
  ])
  assert.match(calls[2].history.map((message) => message.content).join('\n'), /proposer-1/)
  assert.match(calls[2].history.map((message) => message.content).join('\n'), /reviewer-1/)
  assert.equal(events.length, 4)
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
