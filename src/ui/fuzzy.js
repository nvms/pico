export function fuzzyScore(query, path) {
  const q = query.toLowerCase()
  const s = path.toLowerCase()
  if (!q) return 0

  const substringIndex = s.indexOf(q)
  if (substringIndex !== -1) return 10_000 - substringIndex - s.length / 10_000

  let best = -1
  for (let start = s.indexOf(q[0]); start !== -1; start = s.indexOf(q[0], start + 1)) {
    let score = 0
    let prev = -1
    let matched = true
    for (const ch of q) {
      const i = s.indexOf(ch, prev === -1 ? start : prev + 1)
      if (i === -1) {
        matched = false
        break
      }
      if (prev !== -1 && i === prev + 1) score += 3
      if (i === 0 || '/.-_'.includes(s[i - 1])) score += 2
      score += 1
      prev = i
    }
    if (matched && score > best) best = score
  }
  if (best < 0) return -1
  const base = s.slice(s.lastIndexOf('/') + 1)
  if (base.startsWith(q)) best += 8
  else if (base.includes(q)) best += 5
  return best - s.length / 100
}

export function rankFuzzy(items, query, score) {
  if (!query) return items
  return items
    .map((item, index) => ({ item, index, score: score(query, item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}
