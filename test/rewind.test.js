import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { implicitRewindTarget, revertEdits, reapplyEdits } from '../src/core/rewind.js'
import { makeReversibleEdit, makeWriteEdit } from '../src/core/reversible-edit.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pico-rewind-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'v2')
  return { dir, file }
}

test('implicitly rewinds only an empty composer after the latest user message', () => {
  const user = { kind: 'user', text: 'fix this', content: 'fix this', eventId: 'e1' }
  assert.deepEqual(implicitRewindTarget({ transcript: [user] }, ''), {
    text: 'fix this',
    content: 'fix this',
    eventId: 'e1',
    index: 0,
  })
  assert.equal(implicitRewindTarget({ transcript: [user] }, 'more context'), null)
  assert.equal(implicitRewindTarget({ transcript: [user, { kind: 'assistant', text: 'done' }] }, ''), null)
  assert.equal(implicitRewindTarget({ transcript: [] }, ''), null)
})

test('reverts an edit when the file matches', async () => {
  const { file } = await fixture()
  const edits = [{ callId: 'c1', revert: { path: file, before: 'v1', after: 'v2' } }]
  const { reverted, skipped } = await revertEdits(edits)
  assert.deepEqual(reverted, ['c1'])
  assert.equal(skipped.length, 0)
  assert.equal(await readFile(file, 'utf-8'), 'v1')
})

test('skips reverting a drifted file', async () => {
  const { file } = await fixture()
  await writeFile(file, 'v3 hand edited')
  const { reverted, skipped } = await revertEdits([
    { callId: 'c1', revert: { path: file, before: 'v1', after: 'v2' } },
  ])
  assert.equal(reverted.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(await readFile(file, 'utf-8'), 'v3 hand edited')
})

test('reverts stacked edits newest first', async () => {
  const { file } = await fixture()
  await writeFile(file, 'v3')
  const edits = [
    { callId: 'c1', revert: { path: file, before: 'v1', after: 'v2' } },
    { callId: 'c2', revert: { path: file, before: 'v2', after: 'v3' } },
  ]
  const { reverted } = await revertEdits(edits)
  assert.deepEqual(reverted, ['c2', 'c1'])
  assert.equal(await readFile(file, 'utf-8'), 'v1')
})

test('compact edits revert and reapply in order', async () => {
  const { file } = await fixture()
  await writeFile(file, 'alpha THREE omega')
  const first = makeReversibleEdit(file, 'alpha one omega', 'alpha two omega', [{ start: 6, oldText: 'one', newText: 'two' }])
  const second = makeReversibleEdit(file, 'alpha two omega', 'alpha THREE omega', [{ start: 6, oldText: 'two', newText: 'THREE' }])
  const edits = [{ callId: 'c1', revert: first }, { callId: 'c2', revert: second }]

  assert.deepEqual((await revertEdits(edits)).reverted, ['c2', 'c1'])
  assert.equal(await readFile(file, 'utf-8'), 'alpha one omega')
  assert.deepEqual((await reapplyEdits(edits)).reapplied, ['c1', 'c2'])
  assert.equal(await readFile(file, 'utf-8'), 'alpha THREE omega')
})

test('rewinding a compact created-file write removes the file', async () => {
  const { dir } = await fixture()
  const file = join(dir, 'created.txt')
  await writeFile(file, 'created content')
  const edits = [{ callId: 'c1', revert: makeWriteEdit(file, '', 'created content', false) }]

  assert.deepEqual((await revertEdits(edits)).reverted, ['c1'])
  await assert.rejects(access(file), { code: 'ENOENT' })
  assert.deepEqual((await reapplyEdits(edits)).reapplied, ['c1'])
  assert.equal(await readFile(file, 'utf-8'), 'created content')
})

test('reapply restores edits in order', async () => {
  const { file } = await fixture()
  await writeFile(file, 'v1')
  const edits = [
    { callId: 'c1', revert: { path: file, before: 'v1', after: 'v2' } },
    { callId: 'c2', revert: { path: file, before: 'v2', after: 'v3' } },
  ]
  const { reapplied } = await reapplyEdits(edits)
  assert.deepEqual(reapplied, ['c1', 'c2'])
  assert.equal(await readFile(file, 'utf-8'), 'v3')
})
