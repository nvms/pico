const LEVELS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

export function contextBar(percent, width = 4) {
  const eighths = Math.round(Math.max(0, Math.min(100, percent)) * width * 8 / 100)
  const full = Math.floor(eighths / 8)
  const partial = eighths % 8
  return '█'.repeat(full) + (partial ? LEVELS[partial] : '') + ' '.repeat(width - full - (partial ? 1 : 0))
}
