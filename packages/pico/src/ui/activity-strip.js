export function activityRows(rows) {
  const active = (row) => row.status === 'running' || row.status === 'queued'
  return [...rows].sort((a, b) => Number(active(b)) - Number(active(a)))
}

export function activityStripSizes(height, lengths, margin = 1) {
  const groups = lengths.filter(Boolean).length
  if (!groups) return lengths.map(() => 0)
  const budget = Math.floor(height * 0.2)
  const sizes = lengths.map((length) => length ? 1 : 0)
  const used = () => margin + 1 + groups + sizes.reduce((sum, size, i) => sum + size + Number(size < lengths[i]), 0)
  while (true) {
    const candidates = sizes.map((size, i) => i)
      .filter((i) => sizes[i] < lengths[i])
      .sort((a, b) => sizes[a] - sizes[b] || a - b)
    const next = candidates.find((i) => used() + Number(sizes[i] + 1 < lengths[i]) <= budget)
    if (next === undefined) return sizes
    sizes[next]++
  }
}

export function stripWindowStart(current, target, length, size) {
  const max = Math.max(0, length - size)
  const start = Math.max(0, Math.min(current, max))
  const scrolloff = size > 2 ? 1 : 0
  if (target < 0) return start
  if (target < start + scrolloff) return Math.max(0, target - scrolloff)
  if (target >= start + size - scrolloff) return Math.min(max, target - size + scrolloff + 1)
  return start
}
