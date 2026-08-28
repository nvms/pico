import { createSignal, useInterval, useMouse, useResize } from '@trendr/core'
import { accent, FAINT } from './theme.js'

function EmptyCloud({ width, height, version }) {
  const [phase, setPhase] = createSignal(0)
  const [wake, setWake] = createSignal([])
  let previous = null

  useMouse((event) => {
    if (event.action !== 'move' && event.action !== 'drag') return
    const x = event.x
    const y = event.y
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const dx = previous ? x - previous.x : 0
    const dy = previous ? y - previous.y : 0
    previous = { x, y }
    const speed = Math.hypot(dx * 0.5, dy)
    if (speed === 0) return
    setWake(points => [...points.slice(-20), { x, y, dx, dy, speed: Math.min(4, speed), age: 0 }])
  })

  useInterval(() => {
    setPhase(value => value + 0.16)
    setWake(points => points.map(point => ({ ...point, age: point.age + 1 })).filter(point => point.age < 18))
  }, 90)

  const glyphs = '  ··::++**░▒'
  const rows = []
  const base = accent()
  const rgb = /^#([0-9a-f]{6})$/i.exec(base)
  const neighboring = rgb
    ? `#${[
      Math.max(0, parseInt(rgb[1].slice(0, 2), 16) - 18),
      Math.min(255, parseInt(rgb[1].slice(2, 4), 16) + 8),
      Math.min(255, parseInt(rgb[1].slice(4, 6), 16) + 24),
    ].map(value => value.toString(16).padStart(2, '0')).join('')}`
    : base

  for (let y = 0; y < height; y++) {
    const row = []
    for (let x = 0; x < width; x++) {
      const p = phase()
      const broad = Math.sin(x * 0.08 + p) + Math.sin(y * 0.29 - p * 0.7) + Math.sin((x + y) * 0.05 + p * 0.35)
      const wisps = Math.sin(x * 0.19 - y * 0.11 - p * 0.55) + Math.sin(x * 0.03 + y * 0.43 + p * 0.4)
      const pockets = Math.sin(x * 0.31 + p * 0.8) * Math.sin(y * 0.47 - p * 0.3)
      let broadDisplacement = 0
      let wispDisplacement = 0
      let interaction = 0
      for (const point of wake()) {
        const length = Math.hypot(point.dx * 0.5, point.dy) || 1
        const ux = point.dx * 0.5 / length
        const uy = point.dy / length
        const rx = (x - point.x) * 0.5
        const ry = y - point.y
        const along = rx * ux + ry * uy
        const across = -rx * uy + ry * ux
        const trailing = along <= 2 && along >= -18 - point.speed * 3
        if (!trailing) continue
        const age = 1 - point.age / 18
        const trail = Math.exp(-Math.pow((along + 4 + point.age * 0.35) / (7 + point.speed * 2), 2))
        const center = Math.exp(-(across * across) / 5)
        const edges = Math.exp(-Math.pow(Math.abs(across) - 3.2, 2) / 3)
        const force = age * trail * (0.5 + point.speed * 0.45)
        const radialDistance = Math.sqrt(rx * rx + ry * ry)
        const rippleEnvelope = Math.exp(-(radialDistance * radialDistance) / (35 + point.speed * 12))
        const ripple = Math.sin(radialDistance * 1.35 - point.age * 0.75) * rippleEnvelope * age
        wispDisplacement += (edges * 0.9 - center) * force * 1.5 + ripple * (1.2 + point.speed * 0.25)
        broadDisplacement += (edges * 0.45 - center * 0.35) * force * 0.55 + ripple * 0.25
        interaction = Math.max(interaction, Math.abs(ripple) * (0.5 + point.speed * 0.15))
      }
      const value = Math.max(0, Math.min(1, (
        broad + broadDisplacement + (wisps + wispDisplacement) * 0.65 + pockets * 0.8 + 3.2
      ) / 7.4))
      const index = Math.min(glyphs.length - 1, Math.floor(value * glyphs.length))
      row.push({ glyph: glyphs[index], color: interaction > 0.16 ? neighboring : base, dim: index < 8 })
    }
    rows.push(row)
  }

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {rows.map((row, i) => {
        const label = i === 1 ? 'pico' : i === 2 ? `v${version}` : ''
        const inBrandBox = i >= 1 && i <= 2
        const boxStart = 1
        const boxWidth = `v${version}`.length + 2
        const cloud = (cells) => cells.map((cell, x) => (
          <text key={x} style={{ color: cell.color, dim: cell.dim }}>{cell.glyph}</text>
        ))
        return (
          <box key={i} style={{ flexDirection: 'row', height: 1, overflow: 'clip' }}>
            {inBrandBox && cloud(row.slice(0, boxStart))}
            {inBrandBox && (
              <box style={{ width: boxWidth, paddingX: 1 }}>
                {label && <text style={{ bold: i === 1, color: i === 1 ? accent() : FAINT }}>{label}</text>}
              </box>
            )}
            {cloud(row.slice(inBrandBox ? boxStart + boxWidth : 0))}
          </box>
        )
      })}
    </box>
  )
}

export function EmptyState({ version, clouds = false }) {
  const [size, setSize] = createSignal({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 })
  useResize(setSize)
  const width = Math.max(1, size().width)
  const height = Math.max(1, size().height - 4)
  if (!clouds) {
    return (
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <text style={{ bold: true, color: accent() }}>{'  pico'}</text>
        <text style={{ color: FAINT }}>{`  v${version}`}</text>
      </box>
    )
  }

  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <EmptyCloud width={width} height={height} version={version} />
    </box>
  )
}

