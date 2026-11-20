import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeCodeEngine } from '../src/claude-code/engine.js'

// a fake Claude Code that answers one question
function fakeSpawn(seen) {
  return (options) => {
    seen.push(options)
    return {
      alive: true,
      send(content) {
        seen.push(content.map((block) => block.text).join(''))
        queueMicrotask(() => {
          options.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '  kvault' } } })
          options.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' sync  ' } } })
          options.onMessage({ type: 'result', is_error: false, result: '  kvault sync  ' })
        })
        return true
      },
      close() {},
    }
  }
}

test('Claude Code answers one question in a bare run, its system prompt added to its own', async () => {
  const seen = []
  const engine = createClaudeCodeEngine({ spawn: fakeSpawn(seen) })
  const answer = await engine.ask({ modelName: 'claude-code/opus', system: 'Name it', prompt: 'about kvault', effort: 'low' })
  assert.equal(answer, 'kvault sync')
  assert.equal(seen[0].oneShot, true)
  assert.equal(seen[0].appendSystemPrompt, 'Name it')
  assert.equal(seen[0].effort, 'low')
  assert.equal(seen[1], 'about kvault')
})

test('compaction is a question about the transcript', async () => {
  const seen = []
  const engine = createClaudeCodeEngine({ spawn: fakeSpawn(seen) })
  const summary = await engine.compact({ history: [{ role: 'user', content: 'hi' }], modelName: 'claude-code/opus', prompt: 'Summarize' })
  assert.equal(summary, 'kvault sync')
  assert.match(seen[1], /^<transcript>\n[\s\S]*hi[\s\S]*<\/transcript>\n\nSummarize$/)
})
