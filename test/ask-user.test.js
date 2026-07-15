import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolset } from '../src/core/tools/index.js'

function askTool(askUser = async (questions) => ({ questions })) {
  return createToolset({ cwd: process.cwd(), askUser, allowNames: ['ask_user'] }).tools[0]
}

test('ask_user returns the form result', async () => {
  const tool = askTool(async (questions) => ({ answers: questions.map((question) => question.id) }))
  const result = await tool.execute({ questions: [{ id: 'scope', question: 'Which scope?', type: 'text' }] })
  assert.deepEqual(result, { answers: ['scope'] })
})

test('ask_user validates question collections', async () => {
  const tool = askTool()
  await assert.rejects(() => tool.execute({ questions: [] }), /1-10/)
  await assert.rejects(() => tool.execute({ questions: [
    { id: 'same', question: 'First?', type: 'text' },
    { id: 'same', question: 'Second?', type: 'text' },
  ] }), /unique/)
  await assert.rejects(() => tool.execute({ questions: [{ id: 'choice', question: 'Choose?', type: 'single' }] }), /at least one option/)
  await assert.rejects(() => tool.execute({ questions: [{ id: 'bad', question: 'Bad?', type: 'unknown' }] }), /invalid type/)
})
