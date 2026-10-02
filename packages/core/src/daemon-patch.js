import { isDeepStrictEqual } from 'node:util'

export function diffSnapshot(previous, next, path = [], patches = []) {
  if (Object.is(previous, next)) return patches
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    patches.push({ op: 'appendText', path, value: next.slice(previous.length) })
  } else if (Array.isArray(previous) && Array.isArray(next)) {
    const common = Math.min(previous.length, next.length)
    for (let i = 0; i < common; i++) diffSnapshot(previous[i], next[i], [...path, i], patches)
    if (next.length < previous.length) patches.push({ op: 'truncate', path, length: next.length })
    if (next.length > previous.length) patches.push({ op: 'append', path, value: next.slice(previous.length) })
  } else if (previous && next && Object.getPrototypeOf(previous) === Object.prototype && Object.getPrototypeOf(next) === Object.prototype) {
    for (const key of Object.keys(previous)) if (!(key in next)) patches.push({ op: 'delete', path: [...path, key] })
    for (const key of Object.keys(next)) diffSnapshot(previous[key], next[key], [...path, key], patches)
  } else if (!isDeepStrictEqual(previous, next)) patches.push({ op: 'set', path, value: next })
  return patches
}

export function applyPatches(snapshot, patches) {
  function update(value, path, patch) {
    if (!path.length) {
      if (patch.op === 'appendText') return value + patch.value
      if (patch.op === 'append') return [...value, ...patch.value]
      if (patch.op === 'truncate') return value.slice(0, patch.length)
      return patch.value
    }
    const copy = Array.isArray(value) ? [...value] : { ...value }
    const [key, ...rest] = path
    if (!rest.length && patch.op === 'delete') delete copy[key]
    else copy[key] = update(value[key], rest, patch)
    return copy
  }
  for (const patch of patches) snapshot = update(snapshot, patch.path, patch)
  return snapshot
}
