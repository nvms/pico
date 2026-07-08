import { fuzzyScore } from './fuzzy.js'

export function completionContext({ value, resolve }) {
  if (value.includes('\n')) return null
  const m = value.match(/^\/(\S+) (.*)$/)
  if (!m) return null
  const source = resolve(m[1].toLowerCase())
  if (!source || source.length === 0) return null
  const tokens = m[2].split(' ')
  const partial = tokens[tokens.length - 1]
  const matches = source
    .map((s) => [fuzzyScore(partial, s), s])
    .filter(([score]) => score >= 0)
    .sort((a, b) => b[0] - a[0])
    .map(([, s]) => s)
  return { partial, matches, start: value.length - partial.length }
}

export function applyCompletion(value, ctx, candidate) {
  return value.slice(0, ctx.start) + candidate + ' '
}
