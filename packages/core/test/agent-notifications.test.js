import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn } from '../src/agent.js'

const stream = (delta, finishReason) => new Response([
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
  'data: [DONE]\n\n',
].join(''), { headers: { 'content-type': 'text/event-stream' } })

for (const fail of [false, true]) {
  test(`shell notification reaches the next request with complete tool results${fail ? ' and survives provider failure' : ''}`, async t => {
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    const requests = []
    const completed = []
    const pending = []
    const note = { role: 'user', content: '[system notification] background shell 1 exited with code 0.\nRecent output:\nverified' }
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body))
      if (requests.length === 1) return stream({
        role: 'assistant',
        tool_calls: ['first', 'second'].map((name, index) => ({ index, id: `call-${index}`, type: 'function', function: { name, arguments: '{}' } })),
      }, 'tool_calls')
      assert.deepEqual(completed, ['first', 'second'])
      const history = requests[1].messages
      assert.deepEqual(history.slice(-3).map(m => m.role), ['tool', 'tool', 'user'])
      assert.equal(history.at(-1).content, note.content)
      if (fail) throw new Error('test provider failure')
      return stream({ role: 'assistant', content: 'verified' }, 'stop')
    }
    const result = await runTurn({
      history: [{ role: 'user', content: 'run both tools' }],
      recorder: {}, system: 'test', modelName: 'openrouter/test/model', auth: { apiKey: 'test' },
      tools: ['first', 'second'].map(name => ({ name, description: name, schema: {}, execute: async () => {
        completed.push(name)
        if (name === 'first') pending.push(note)
        await new Promise(resolve => setTimeout(resolve, 5))
        return name
      } })),
      beforeRequest: () => pending.splice(0),
    })
    assert.equal(result.messages.filter(m => m.role === 'tool').length, 2, result.error)
    assert.equal(result.messages.filter(m => m.content === note.content).length, 1, JSON.stringify(result))
    assert.equal(result.interrupted, fail)
    if (fail) assert.match(result.error, /test provider failure/)
    else assert.equal(result.messages.at(-1).content, 'verified')
  })
}
