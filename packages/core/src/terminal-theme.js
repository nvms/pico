const OSC11_RE = /\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i

function osc11Channels(response) {
  const match = response.match(OSC11_RE)
  if (!match) return null
  return [match[1], match[2], match[3]].map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1))
}

export function parseOsc11(response) {
  const channels = osc11Channels(response)
  if (!channels) return null
  const [r, g, b] = channels
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

// the reported background as '#rrggbb'
export function parseOsc11Background(response) {
  const channels = osc11Channels(response)
  if (!channels) return null
  return '#' + channels.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
}

export function themeFromColorfgbg(value) {
  const token = (value || '').split(';').at(-1)
  if (!/^\d+$/.test(token)) return null
  const bg = Number(token)
  return bg === 7 || bg === 15 ? 'light' : 'dark'
}

// resolves { theme: 'light' | 'dark', background: '#rrggbb' | null }
export function detectTerminalTheme({ timeoutMs = 150 } = {}) {
  const fallback = () => ({ theme: themeFromColorfgbg(process.env.COLORFGBG) || 'dark', background: null })
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(fallback())

  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const wasRaw = process.stdin.isRaw

    // never pause() here: an explicit pause sticks, and trend's mount only
    // attaches a data listener, which will not un-pause an explicitly
    // paused stream - input would be frozen for the whole session
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.setRawMode(wasRaw)
      resolve(result)
    }

    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const theme = parseOsc11(buffer)
      if (theme) finish({ theme, background: parseOsc11Background(buffer) })
    }

    const timer = setTimeout(() => finish(fallback()), timeoutMs)
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.resume()
    process.stdout.write('\x1b]11;?\x1b\\')
  })
}
