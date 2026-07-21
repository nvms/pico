import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationMatches, highlightConversation, matchOffsets } from '../src/ui/conversation-search.js'

test('matches text case-insensitively and treats the query literally', () => {
  assert.deepEqual(matchOffsets('Foo f.o FOO', 'foo'), [0, 8])
  assert.deepEqual(matchOffsets('a.b aab', 'a.b'), [0])
})

test('tool titles remain searchable while collapsed output is excluded', () => {
  const items = [{ kind: 'tool', name: 'grep', title: 'visible foo title', fullOutput: 'hidden foo output' }]
  const collapsed = conversationMatches(items, 'foo', false)
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].field, 'title')
  const expanded = conversationMatches(items, 'foo', true)
  assert.equal(expanded.length, 2)
  assert.deepEqual(expanded.map((match) => match.field), ['title', 'fullOutput'])
})

test('collapsed thoughts are excluded until verbose output is shown', () => {
  const items = [{ kind: 'thoughts', text: 'hidden foo reasoning' }]
  assert.equal(conversationMatches(items, 'foo', false).length, 0)
  assert.equal(conversationMatches(items, 'foo', true).length, 1)
  assert.equal(highlightConversation(items, 'foo', 0, false)[0].text, 'hidden foo reasoning')
  assert.match(highlightConversation(items, 'foo', 0, true)[0].text, /\x1b\[7;33mfoo/)
})

test('matches record their rendered line within the message', () => {
  const matches = conversationMatches([{ kind: 'assistant', text: 'first\nfoo\nfoo' }], 'foo')
  assert.deepEqual(matches.map((match) => match.line), [2, 3])
})

test('search excludes truncated thought and tool output lines', () => {
  const thought = { kind: 'thoughts', text: `${'line\n'.repeat(300)}hidden foo` }
  const tool = { kind: 'tool', title: 'read', fullOutput: `${'line\n'.repeat(200)}hidden foo` }
  assert.equal(conversationMatches([thought, tool], 'foo', true).length, 0)
})

test('expanded content matches use rendered line offsets', () => {
  const items = [
    { kind: 'thoughts', text: 'foo' },
    { kind: 'tool', title: 'foo', fullOutput: 'foo' },
  ]
  assert.deepEqual(conversationMatches(items, 'foo', true).map((match) => match.line), [3, 1, 4])
})

test('tool groups and expanded agent notices join the visible search corpus', () => {
  const items = [
    { kind: 'tool-group', tools: [{ kind: 'tool', fullOutput: 'foo' }, { kind: 'tool', fullOutput: 'foo foo' }] },
    { kind: 'agent-notice-group', notices: [{ kind: 'system', text: 'foo' }] },
  ]
  assert.equal(conversationMatches(items, 'foo', false).length, 0)
  assert.equal(conversationMatches(items, 'foo', true).length, 4)
})

test('highlights all visible matches and distinguishes the current match', () => {
  const [item] = highlightConversation([{ kind: 'assistant', text: 'foo foo' }], 'foo', 1)
  assert.match(item.text, /\x1b\[7mfoo/)
  assert.match(item.text, /\x1b\[7;33mfoo/)
})

test('highlights matches in decorated tool titles', () => {
  const [item] = highlightConversation([{ kind: 'tool', name: 'grep', title: 'foo foo', fullOutput: 'foo' }], 'foo', 1, false)
  assert.match(item.title, /\x1b\[7mfoo/)
  assert.match(item.title, /\x1b\[7;33mfoo/)
  assert.equal(item.fullOutput, 'foo')
})
