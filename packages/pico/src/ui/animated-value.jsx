import { ease, linear, useAnimated } from '@trendr/core'

function toRgb(color) {
  if (color?.startsWith('#') && color.length === 7) {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ]
  }
  return [127, 127, 127]
}

function mixColor(from, to, amount) {
  const a = toRgb(from)
  const b = toRgb(to)
  const channels = a.map((value, i) => Math.round(value + (b[i] - value) * amount))
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function AnimatedValue({ value, initial = value, duration = 1000, color, highlight, format = String }) {
  const displayed = useAnimated(initial, ease(duration))
  const glow = useAnimated(0, ease(duration, linear))

  if (value !== displayed._anim.target) {
    displayed.set(value)
    glow.snap(1)
    glow.set(0)
  }

  return (
    <text style={{ color: mixColor(color, highlight, glow()) }}>
      {format(displayed())}
    </text>
  )
}
