import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applySplices, contentHash, reversibleEditVersion } from './reversible-edit.js'

export function implicitRewindTarget(state, input) {
  if (input !== '') return null
  const last = state.transcript.at(-1)
  if (last?.kind !== 'user') return null
  return { text: last.text, content: last.content, index: state.transcript.length - 1, eventId: last.eventId }
}

async function readCurrent(path) {
  try {
    return { exists: true, text: await readFile(path, 'utf-8') }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, text: '' }
    throw err
  }
}

function matches(current, expected) {
  return current.exists === expected.exists && (!current.exists || contentHash(current.text) === expected.hash)
}

async function writeState(path, state) {
  if (!state.exists) {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, state.text, 'utf-8')
}

async function transform(edit, direction) {
  const revert = edit.revert
  const version = reversibleEditVersion(revert)
  if (!version) return { reason: 'invalid reversible edit data' }
  const current = await readCurrent(revert.path)

  if (version === 1) {
    const expected = direction === 'undo' ? revert.after : revert.before
    if (!current.exists || current.text !== expected) return { reason: direction === 'undo' ? 'file changed since edit' : 'file changed since revert' }
    await writeState(revert.path, { exists: true, text: direction === 'undo' ? revert.before : revert.after })
    return { ok: true }
  }

  const expected = direction === 'undo' ? revert.after : revert.before
  const target = direction === 'undo' ? revert.before : revert.after
  if (!matches(current, expected)) return { reason: direction === 'undo' ? 'file changed since edit' : 'file changed since revert' }

  try {
    const text = applySplices(current.text, revert, direction === 'undo' ? 'reverse' : 'forward')
    if (target.exists && contentHash(text) !== target.hash) return { reason: 'reversible edit data is corrupt' }
    await writeState(revert.path, { exists: target.exists, text })
    return { ok: true }
  } catch {
    return { reason: 'reversible edit data is corrupt' }
  }
}

async function applyEdits(edits, direction) {
  const applied = []
  const skipped = []
  for (const edit of direction === 'undo' ? [...edits].reverse() : edits) {
    try {
      const result = await transform(edit, direction)
      if (result.ok) applied.push(edit.callId)
      else skipped.push({ path: edit.revert?.path, callId: edit.callId, reason: result.reason })
    } catch (err) {
      skipped.push({ path: edit.revert?.path, callId: edit.callId, reason: err.message || String(err) })
    }
  }
  return { applied, skipped }
}

export async function revertEdits(edits) {
  const { applied, skipped } = await applyEdits(edits, 'undo')
  return { reverted: applied, skipped }
}

export async function reapplyEdits(edits) {
  const { applied, skipped } = await applyEdits(edits, 'redo')
  return { reapplied: applied, skipped }
}
