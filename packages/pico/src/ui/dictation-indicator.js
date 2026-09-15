const bars = '▁▂▃▄▅▆▇█'
const width = 16

export function appendLevel(levels, level) {
  return [...levels.slice(1 - width), Math.max(0, Math.min(1, level))]
}

export function dictationIndicator(status, levels) {
  if (status === 'idle') return ''
  if (status !== 'recording') return ` ${status} `
  const samples = [...Array(Math.max(0, width - levels.length)).fill(0), ...levels.slice(-width)]
  return ` ${samples.map((level) => bars[Math.round(level * (bars.length - 1))]).join('')} recording `
}
