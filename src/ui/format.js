export function compactNumber(value) {
  const n = Math.round(value)
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
