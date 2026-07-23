import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentManager, reduceAgentEvents, resultText } from '../src/core/agents.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('resultText returns the last assistant response', () => {
  assert.equal(resultText([
    { role: 'assistant', content: 'first' },
    { role: 'tool', content: '{}' },
    { role: 'assistant', content: 'final' },
  ]), 'final')
})

test('agent manager queues, runs, and collects isolated results', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const manager = createAgentManager({
    concurrency: 1,
    defaults: () => ({ model: 'provider/small' }),
    run: async (agent, signal, stream) => {
      stream({ type: 'content', content: agent.prompt })
      await gate
      return { messages: [{ role: 'assistant', content: `done ${agent.prompt}` }] }
    },
  })
  const first = manager.start({ prompt: 'one' })
  const second = manager.start({ prompt: 'two' })
  await tick()
  assert.equal(first.status, 'running')
  assert.equal(second.status, 'queued')
  assert.equal(first.model, 'provider/small')
  release()
  const results = await manager.collect([first.id, second.id])
  assert.deepEqual(results.map((a) => a.result), ['done one', 'done two'])
  assert.ok(first.events.length)
})

test('manager lifecycle hooks observe creation and failures', async () => {
  const lifecycle = []
  const manager = createAgentManager({
    run: () => { throw new Error('broken') },
    onCreate: (agent) => lifecycle.push(`create:${agent.status}`),
    onFinish: (agent) => lifecycle.push(`finish:${agent.status}:${agent.error}`),
  })
  const agent = manager.start({ prompt: 'fail' })
  await agent.done
  assert.deepEqual(lifecycle, ['create:queued', 'finish:failed:broken'])
})

test('queued cancellation completes lifecycle', async () => {
  const finished = []
  const manager = createAgentManager({ concurrency: 0, run: async () => '', onFinish: (agent) => finished.push(agent.status) })
  const agent = manager.start({ prompt: 'cancel me' })
  manager.cancel(agent.id)
  await agent.done
  assert.deepEqual(finished, ['cancelled'])
})

test('returned agent errors are failures', async () => {
  const manager = createAgentManager({ run: async () => ({ messages: [], error: 'provider failed' }) })
  const agent = manager.start({ prompt: 'fail' })
  await agent.done
  assert.equal(agent.status, 'failed')
  assert.equal(agent.error, 'provider failed')
})

test('agent tools enforce a model-declared per-turn spawn limit', async () => {
  const { createToolset } = await import('../src/core/tools/index.js')
  const started = []
  const agents = { start: (options) => { const agent = { id: String(started.length + 1), status: 'queued', ...options }; started.push(agent); return agent }, list: () => [], collect: async () => [], cancel: () => true }
  const { tools } = createToolset({ cwd: process.cwd(), agents, sessionId: 'session-1', sessionFile: '/tmp/session-1.jsonl', maxAgentStarts: 10, requireAgentPlan: true, allowNames: ['agent_plan', 'agent_start'] })
  const plan = tools.find((tool) => tool.name === 'agent_plan')
  const start = tools.find((tool) => tool.name === 'agent_start')
  await assert.rejects(() => start.execute({ prompt: 'early', description: 'early' }), /agent_plan/)
  assert.deepEqual(await plan.execute({ count: 2, reason: 'the user requested two' }), { agentLimit: 2, reason: 'the user requested two' })
  await start.execute({ prompt: 'one', description: 'one' })
  await start.execute({ prompt: 'two', description: 'two' })
  await assert.rejects(() => start.execute({ prompt: 'three', description: 'three' }), /agent limit reached.*2/)
  assert.equal(started.length, 2)
  assert.equal(started[0].sessionId, 'session-1')
  assert.equal(started[0].sessionFile, '/tmp/session-1.jsonl')
})

test('collecting through the toolset reports collected agent ids', async () => {
  const { createToolset } = await import('../src/core/tools/index.js')
  const collectedIds = []
  const agents = {
    collect: async () => [{ id: '4', status: 'completed', result: 'done' }],
    list: () => [],
    start: () => {},
    cancel: () => false,
  }
  const { tools } = createToolset({ cwd: process.cwd(), agents, onAgentsCollected: (ids) => collectedIds.push(...ids) })
  const collect = tools.find((tool) => tool.name === 'agent_collect')
  assert.deepEqual(await collect.execute({ ids: ['4'] }), { agents: [{ id: '4', status: 'completed', result: 'done', error: undefined }] })
  assert.deepEqual(collectedIds, ['4'])
})

test('agent events restore completed and interrupted agents', () => {
  const restored = reduceAgentEvents([
    { type: 'agent_start', at: 10, data: { agentId: '3', prompt: 'research', description: 'worker', model: 'provider/small', sessionId: 'session-1', sessionFile: '/tmp/session-1.jsonl' } },
    { type: 'agent_event', at: 20, data: { agentId: '3', event: { type: 'tool_executing', call: { function: { name: 'web_search' } } } } },
    { type: 'agent_event', at: 30, data: { agentId: '3', event: { type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } } } },
    { type: 'agent_result', at: 40, data: { agentId: '3', messages: [{ role: 'assistant', content: 'finding' }], usage: { promptTokens: 10, completionTokens: 3 } } },
    { type: 'agent_start', at: 50, data: { agentId: '4', prompt: 'unfinished' } },
    { type: 'agent_start', at: 60, data: { agentId: '5', prompt: 'dismissed' } },
    { type: 'agent_result', at: 70, data: { agentId: '5', result: 'done' } },
    { type: 'agent_dismiss', at: 80, data: { agentId: '5' } },
  ])
  assert.equal(restored[0].status, 'completed')
  assert.equal(restored[0].result, 'finding')
  assert.equal(restored[0].events.length, 2)
  assert.equal(restored[0].usage.completionTokens, 3)
  assert.equal(restored[0].sessionId, 'session-1')
  assert.equal(restored[0].sessionFile, '/tmp/session-1.jsonl')
  assert.equal(restored[1].status, 'cancelled')
  assert.equal(restored[0].done instanceof Promise, true)
  assert.equal(restored.some((agent) => agent.id === '5'), false)
})

test('manager restore replaces agents, supports collection, and continues ids', async () => {
  const manager = createAgentManager({ concurrency: 0, run: async () => '' })
  manager.start({ prompt: 'discarded' })
  manager.restore([{ type: 'agent_start', at: 1, data: { agentId: '8', prompt: 'restored' } }])
  assert.deepEqual(manager.list().map((agent) => agent.id), ['8'])
  assert.deepEqual((await manager.collect(['8'])).map((agent) => agent.id), ['8'])
  assert.equal(manager.start({ prompt: 'next' }).id, '9')
})

test('finished agents can be dismissed but active agents cannot', async () => {
  const manager = createAgentManager({ concurrency: 0, run: async () => '' })
  const agent = manager.start({ prompt: 'dismiss me' })
  assert.equal(manager.dismiss(agent.id), false)
  manager.cancel(agent.id)
  await agent.done
  assert.equal(manager.dismiss(agent.id), true)
  assert.equal(manager.get(agent.id), null)
  assert.equal(manager.dismiss(agent.id), false)
})

test('queued agents can be cancelled', async () => {
  const manager = createAgentManager({ concurrency: 0, run: async () => '' })
  const agent = manager.start({ prompt: 'never' })
  assert.equal(manager.cancel(agent.id), true)
  await agent.done
  assert.equal(agent.status, 'cancelled')
})
