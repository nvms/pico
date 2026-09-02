import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settlePending } from '../src/pending.js'
import { buildUserContent, finalizeUserContent } from '../src/attachments.js'

test('a view delivery stays apart from user text at the end of a turn', () => {
  const settled = settlePending({ views: ['[view: shot.png]\n[Image #1]'], expedited: [], queued: ['make it green\n[Image #2]'] })
  assert.deepEqual(settled.views, ['[view: shot.png]\n[Image #1]'])
  assert.deepEqual(settled.messages, ['make it green\n[Image #2]'])
  assert.deepEqual(settled.queued, [])
})

test('after a tool only the expedited text goes, the queue waits, views still go', () => {
  const settled = settlePending({ views: ['v'], expedited: ['now'], queued: ['later'], afterTool: true })
  assert.deepEqual(settled, { views: ['v'], messages: ['now'], queued: ['later'], recall: [] })
})

test('an interrupt returns user text to the composer and drops the views', () => {
  const settled = settlePending({ views: ['v'], expedited: ['a'], queued: ['b'], interrupted: true })
  assert.deepEqual(settled, { views: [], messages: [], queued: [], recall: ['a', 'b'] })
})

test('a view label is never rescanned for its image path', () => {
  const attachments = new Map([['[Image #1]', { path: '/tmp/shot.png', mediaType: 'image/png' }]])
  const text = '[view: /tmp/shot.png]\n[Image #1]'
  const viewed = buildUserContent(text, new Map(attachments))
  assert.equal(viewed.content.filter((p) => p.type === 'image').length, 1)
  const scanned = finalizeUserContent(text, new Map(attachments), () => true)
  assert.equal(scanned.content.filter((p) => p.type === 'image').length, 2)
})
