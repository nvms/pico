import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTranscript } from '../src/agent-transcript.js'
import { createRecorder, recorded, toolResultOutput } from '../src/tools/recorder.js'

test('bash transcript shows command output rather than tool metadata', () => {
  const call = { id: 'bash-1', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hello', description: 'Testing output' }) } }
  const items = agentTranscript({ prompt: 'test', events: [
    { type: 'tool_executing', call },
    { type: 'tool_complete', call, result: { stdout: 'hello\n', stderr: '', exitCode: 0 } },
  ] })
  assert.equal(items[1].title, 'echo hello')
  assert.equal(items[1].fullOutput, 'hello\n')
  assert.equal(items[1].exitCode, 0)
})

test('bash output preserves errors and omits background metadata', () => {
  assert.equal(toolResultOutput('bash', { stdout: '', stderr: 'bad command\n', exitCode: 1 }), 'bad command\n')
  assert.equal(toolResultOutput('bash', { shellId: '1', status: 'running', note: 'background' }), '')
  assert.equal(toolResultOutput('other', { count: 1 }), '{\n  "count": 1\n}')
})

test('recorded bash does not replace empty output with tool metadata', async () => {
  const recorder = createRecorder()
  await recorded(recorder, 'bash', async () => ({ stdout: '', stderr: '', exitCode: 0 }))({ command: 'true' })
  assert.equal(recorder.entries[0].fullOutput, '')
  await recorded(recorder, 'bash', async () => {
    recorder.extra({ fullOutput: '' })
    return { stdout: '\u001b[0m', stderr: '', exitCode: 0 }
  })({ command: 'true' })
  assert.equal(recorder.entries[1].fullOutput, '')
})
