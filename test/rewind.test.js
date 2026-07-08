import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revertEdits, reapplyEdits } from '../src/core/rewind.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pico-rewind-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'v2')
  return { dir, file }
}

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
