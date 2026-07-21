import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INIT_PROMPT, initPrompt } from '../src/core/init.js'

test('init prompt requires direct discovery and concise AGENTS.md guidance', () => {
  assert.match(INIT_PROMPT, /Do this discovery yourself as the main agent/)
  assert.match(INIT_PROMPT, /Do not call agent_plan, agent_start, agent_list, agent_collect/)
  assert.match(INIT_PROMPT, /100-200 lines or roughly 1,000-2,000 tokens/)
  assert.match(INIT_PROMPT, /3,000 tokens as a hard default ceiling/)
  assert.match(INIT_PROMPT, /focused AGENTS\.md files in those subtrees/)
})

test('init prompt includes optional user arguments', () => {
  assert.equal(initPrompt(''), INIT_PROMPT)
  assert.match(initPrompt('focus on deployment'), /Additional request from the user:\nfocus on deployment$/)
})
