import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, compactHistory } from '../src/agent.js'

function response(tool = false) {
  const events = tool ? [
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'tool-1', name: 'check', arguments: '{}' } },
  ] : [{ type: 'response.output_text.delta', output_index: 0, delta: 'done' }]
  events.push({ type: 'response.completed', response: { service_tier: 'default', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

for (const speed of ['standard', 'fast']) {
  test(`Codex ${speed} reaches every tool-loop request`, async t => {
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    const requests = []
    globalThis.fetch = async (_url, init) => {
      requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) })
      return response(requests.length === 1)
    }
    const result = await runTurn({
      history: [{ role: 'user', content: 'check' }],
      modelName: 'codex/gpt-6.1-sol', speed, effort: 'low', system: 'test',
      auth: { apiKey: 'test', headers: { 'chatgpt-account-id': 'test' } },
      recorder: {}, tools: [{ name: 'check', description: 'check', schema: {}, execute: async () => 'ok' }],
    })
    assert.equal(result.interrupted, false, result.error)
    assert.equal(requests.length, 2)
    for (const { body, headers } of requests) {
      assert.equal(body.service_tier, speed === 'fast' ? 'priority' : undefined)
      assert.equal(body.reasoning.effort, 'low')
      if (speed === 'fast') assert.match(headers.get('x-codex-routing-hint'), /tier=priority/)
    }
  })
}

test('compaction forwards the requested Codex speed', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).service_tier, 'priority')
    return response()
  }
  assert.equal(await compactHistory({ history: [], modelName: 'codex/gpt-6.1-sol', speed: 'fast', auth: { apiKey: 'test' }, prompt: 'compact' }), 'done')
})
