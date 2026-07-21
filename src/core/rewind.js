import { readFile, writeFile } from 'node:fs/promises'

export function implicitRewindTarget(state, input) {
  if (input !== '') return null
  const last = state.transcript.at(-1)
  if (last?.kind !== 'user') return null
  return { text: last.text, content: last.content, index: state.transcript.length - 1, eventId: last.eventId }
}

async function readCurrent(path) {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function revertEdits(edits) {
  const reverted = []
  const skipped = []
  for (const edit of [...edits].reverse()) {
    const { path, before, after } = edit.revert
    const current = await readCurrent(path)
    if (current === after) {
      await writeFile(path, before, 'utf-8')
      reverted.push(edit.callId)
    } else {
      skipped.push({ path, callId: edit.callId, reason: 'file changed since edit' })
    }
  }
  return { reverted, skipped }
}

export async function reapplyEdits(edits) {
  const reapplied = []
  const skipped = []
  for (const edit of edits) {
    const { path, before, after } = edit.revert
    const current = await readCurrent(path)
    if (current === before) {
      await writeFile(path, after, 'utf-8')
      reapplied.push(edit.callId)
    } else {
      skipped.push({ path, callId: edit.callId, reason: 'file changed since revert' })
    }
  }
  return { reapplied, skipped }
}
