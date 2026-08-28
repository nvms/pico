import { createHash } from 'node:crypto'

export const REVERSIBLE_EDIT_VERSION = 2

export function contentHash(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function state(exists, text) {
  return { exists, hash: exists ? contentHash(text) : null }
}

export function makeReversibleEdit(path, before, after, splices, { beforeExists = true, afterExists = true } = {}) {
  return {
    version: REVERSIBLE_EDIT_VERSION,
    path,
    before: state(beforeExists, before),
    after: state(afterExists, after),
    splices,
  }
}

export function makeWriteEdit(path, before, after, beforeExists) {
  let start = 0
  const shared = Math.min(before.length, after.length)
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start++

  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
    beforeEnd--
    afterEnd--
  }

  return makeReversibleEdit(path, before, after, [{
    start,
    oldText: before.slice(start, beforeEnd),
    newText: after.slice(start, afterEnd),
  }], { beforeExists })
}

export function reversibleEditVersion(revert) {
  if (revert?.version === REVERSIBLE_EDIT_VERSION && Array.isArray(revert.splices)) return 2
  if (typeof revert?.before === 'string' && typeof revert?.after === 'string') return 1
  return null
}

function validatedSplices(revert) {
  let end = 0
  return revert.splices.map((splice) => {
    if (!Number.isSafeInteger(splice?.start) || splice.start < end || typeof splice.oldText !== 'string' || typeof splice.newText !== 'string') {
      throw new Error('invalid reversible edit splices')
    }
    end = splice.start + splice.oldText.length
    return splice
  })
}

export function applySplices(source, revert, direction) {
  const splices = validatedSplices(revert)
  const parts = []
  let sourceAt = 0
  let delta = 0

  for (const splice of splices) {
    const start = direction === 'forward' ? splice.start : splice.start + delta
    const oldText = direction === 'forward' ? splice.oldText : splice.newText
    const newText = direction === 'forward' ? splice.newText : splice.oldText
    if (start < sourceAt || start + oldText.length > source.length || source.slice(start, start + oldText.length) !== oldText) {
      throw new Error('reversible edit does not match file content')
    }
    parts.push(source.slice(sourceAt, start), newText)
    sourceAt = start + oldText.length
    delta += splice.newText.length - splice.oldText.length
  }

  parts.push(source.slice(sourceAt))
  return parts.join('')
}
