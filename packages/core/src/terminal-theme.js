export function parseOsc11(response) {
  const match = response.match(/\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i)
  if (!match) return null
  const channel = (hex) => parseInt(hex, 16) / (16 ** hex.length - 1)
  const luminance = 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3])
  return luminance > 0.5 ? 'light' : 'dark'
}

export function themeFromColorfgbg(value) {
  const token = (value || '').split(';').at(-1)
  if (!/^\d+$/.test(token)) return null
  const bg = Number(token)
  return bg === 7 || bg === 15 ? 'light' : 'dark'
}

export function detectTerminalTheme({ timeoutMs = 150 } = {}) {
  const fallback = () => themeFromColorfgbg(process.env.COLORFGBG) || 'dark'
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(fallback())

  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const wasRaw = process.stdin.isRaw

    // never pause() here: an explicit pause sticks, and trend's mount only
    // attaches a data listener, which will not un-pause an explicitly
    // paused stream - input would be frozen for the whole session
    const finish = (theme) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.setRawMode(wasRaw)
      resolve(theme)
    }

    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const theme = parseOsc11(buffer)
      if (theme) finish(theme)
    }

    const timer = setTimeout(() => finish(fallback()), timeoutMs)
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.resume()
    process.stdout.write('\x1b]11;?\x1b\\')
  })
}
