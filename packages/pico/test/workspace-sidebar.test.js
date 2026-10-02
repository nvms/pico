import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceGroups, workspaceSelection, workspaceNavigate, workspaceAction, workspaceDraftAttachments, emptyWorkspaceComposer } from '../src/ui/workspace-sidebar.js'

const rows = [{ id: 'a', cwd: '/a', name: 'Alpha' }, { id: 'b', cwd: '/a', name: 'Beta' }, { id: 'c', cwd: '/b', name: 'Gamma' }]

test('groups only named live rows by exact cwd with stable session ordering', () => {
  assert.deepEqual(workspaceGroups([rows[2], rows[0], { id: 'none', cwd: '/a', name: ' ' }, rows[1]]), [
    { cwd: '/a', sessions: rows.slice(0, 2) }, { cwd: '/b', sessions: rows.slice(2) },
  ])
})

test('selection survives updates and chooses nearest remaining row after removal', () => {
  assert.equal(workspaceSelection(rows, 'b'), 'b')
  assert.equal(workspaceSelection([rows[0], rows[2]], 'b', rows), 'c')
  assert.equal(workspaceSelection([], 'b', rows), null)
})

test('navigation clamps ends, handles vim and arrow keys, and half pages', () => {
  for (const key of ['down', 'j']) assert.equal(workspaceNavigate(rows, 'a', { key }, 12), 'b')
  for (const key of ['up', 'k']) assert.equal(workspaceNavigate(rows, 'b', { key }, 12), 'a')
  assert.equal(workspaceNavigate(rows, 'a', { key: 'k' }, 12), 'a')
  assert.equal(workspaceNavigate(rows, 'b', { key: 'g' }, 12), 'a')
  assert.equal(workspaceNavigate(rows, 'a', { key: 'G' }, 12), 'c')
  assert.equal(workspaceNavigate(rows, 'a', { key: 'd', ctrl: true }, 12), 'c')
  assert.equal(workspaceNavigate(rows, 'c', { key: 'u', ctrl: true }, 12), 'a')
  assert.equal(workspaceNavigate([], null, { key: 'j' }, 12), null)
  assert.equal(workspaceNavigate(rows, 'a', { key: 'l' }, 12), undefined)
  assert.equal(workspaceNavigate(rows, 'a', { key: 'j', ctrl: true }, 12), undefined)
})

test('left entry requires a completely empty composer', () => {
  const empty = { text: '', attachments: 0, dictation: 'idle', capture: 'idle', pending: false, history: -1, completion: false, command: null, question: null, steer: null, queued: 0, expedited: 0 }
  assert.equal(emptyWorkspaceComposer(empty), true)
  for (const [key, value] of Object.entries({ text: ' ', attachments: 1, dictation: 'recording', capture: 'capturing', pending: true, history: 0, completion: true, command: {}, question: {}, steer: {}, queued: 1, expedited: 1 })) {
    assert.equal(emptyWorkspaceComposer({ ...empty, [key]: value }), false, key)
  }
})

test('ctrl+x interrupts busy, demotes idle, leaves paused alone', () => {
  assert.equal(workspaceAction({ status: 'busy' }), 'interrupt')
  assert.equal(workspaceAction({ status: 'idle' }), 'demote')
  assert.equal(workspaceAction({ status: 'paused' }), null)
  assert.equal(workspaceAction(null), null)
})

test('historical attachments do not block an empty composer', () => {
  const attachments = new Map([['[Image #1]', {}], ['[File #2]', {}]])
  assert.equal(workspaceDraftAttachments('', attachments), 0)
  assert.equal(workspaceDraftAttachments('[Image #1] [File #2]', attachments), 2)
  assert.equal(workspaceDraftAttachments('[Image #9]', attachments), 0)
})
