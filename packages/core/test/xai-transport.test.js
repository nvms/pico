import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, compactHistory, summarizeText } from '../src/agent.js'
import { modelRequest } from '../src/model-auth.js'

function response(tool = false) {
  const events = tool
    ? [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'check', arguments: '{}' } }]
    : [{ type: 'response.output_text.delta', output_index: 0, delta: 'done' }]
  events.push({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
}

test('subscription routing requires OAuth, never an API key', () => {
  assert.throws(() => modelRequest('grok/grok-4', { apiKey: 'paid-key' }), /sign-in/)
  assert.deepEqual(modelRequest('xai/grok-4', { apiKey: 'paid-key' }), { model: 'xai/grok-4', apiKey: 'paid-key' })
})

test('Grok subscription streams tools and retains subscription routing on every round', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) })
    return response(requests.length === 1)
  }
  const result = await runTurn({
    history: [{ role: 'user', content: 'check' }], modelName: 'grok/grok-4',
    auth: { accessToken: 'subscription-token' }, system: 'test', recorder: {},
    tools: [{ name: 'check', description: 'check', schema: {}, execute: async () => 'ok' }],
  })
  assert.equal(result.interrupted, false, result.error)
  assert.equal(result.messages.at(-1).content, 'done')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.url, 'https://cli-chat-proxy.grok.com/v1/responses')
    assert.equal(request.headers.get('authorization'), 'Bearer subscription-token')
    assert.equal(request.headers.has('chatgpt-account-id'), false)
    assert.equal(request.body.model, 'grok-4')
    assert.equal(request.body.service_tier, undefined)
  }
  assert.ok(requests[1].body.input.some(item => item.type === 'function_call_output' && item.output === '"ok"'))
})

test('compaction and summarization use subscription credentials', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/responses')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer subscription-token')
    return response()
  }
  const options = { modelName: 'grok/grok-4', auth: { accessToken: 'subscription-token' } }
  assert.equal(await compactHistory({ ...options, history: [], prompt: 'compact' }), 'done')
  assert.equal(await summarizeText({ ...options, text: 'conversation' }), 'done')
})

test('subscription rejection does not fall back to API billing', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let count = 0
  globalThis.fetch = async () => { count++; return new Response('subscription quota exhausted', { status: 403 }) }
  const result = await runTurn({ history: [], tools: [], modelName: 'grok/grok-4', auth: { accessToken: 'subscription-token' } })
  assert.match(result.error, /403.*quota exhausted/)
  assert.equal(count, 1)
})
