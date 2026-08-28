const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const MAX_ACTIVE_SGR = 32

export function stripAnsi(text) {
  return String(text).replace(CSI_RE, '')
}

function isReset(params) {
  return params === '' || params === '0' || params.split(';').every((code) => code === '0' || code === '')
}

// remembers which sgr sequences are still in effect so a line that starts
// mid-style can be prefixed with exactly the sequences the terminal would
// have applied, without interpreting colors at all
export function createSgrTracker() {
  let active = []
  let pending = ''

  function feed(text) {
    const input = pending + String(text)
    pending = ''
    let i = 0
    while (i < input.length) {
      const start = input.indexOf('\x1b[', i)
      if (start === -1) break
      let end = start + 2
      while (end < input.length && !(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)) end++
      if (end >= input.length) {
        pending = input.slice(start)
        break
      }
      if (input[end] === 'm') apply(input.slice(start + 2, end))
      i = end + 1
    }
  }

  function apply(params) {
    if (isReset(params)) {
      active = []
      return
    }
    if (params.startsWith('0;')) active = []
    active.push(params.startsWith('0;') ? params.slice(2) : params)
    if (active.length > MAX_ACTIVE_SGR) active = active.slice(-MAX_ACTIVE_SGR)
  }

  function style() {
    return active.map((params) => `\x1b[${params}m`).join('')
  }

  return { feed, style }
}
