import { createSignal } from '@trendr/core'

const PALETTES = {
  dark: {
    desc: 'light text for dark terminals',
    accent: '#a78bfa',
    fg: '#e5e7eb',
    fgSoft: '#9ca3af',
    muted: '#b8c0d0',
    panelBg: '#1e1e22',
    selectBg: '#374151',
    red: '#f87171',
    green: '#4ade80',
    peer: '#c4b5fd',
    highlight: '#ffffff',
    shiki: 'nord',
  },
  light: {
    desc: 'dark text for light terminals',
    accent: '#7c3aed',
    fg: '#1f2430',
    fgSoft: '#4b5563',
    muted: '#4b5563',
    panelBg: '#e9e9ee',
    selectBg: '#d4d4dc',
    red: '#dc2626',
    green: '#16a34a',
    peer: '#6d28d9',
    highlight: '#111827',
    shiki: 'github-light',
  },
  nord: {
    desc: 'arctic blues on polar night',
    accent: '#88c0d0',
    fg: '#d8dee9',
    fgSoft: '#aab2c4',
    muted: '#b8c0d0',
    panelBg: '#3b4252',
    selectBg: '#434c5e',
    red: '#bf616a',
    green: '#a3be8c',
    peer: '#d8b4fe',
    highlight: '#eceff4',
    shiki: 'nord',
  },
}

// the dark and light palettes sit on the terminal's own background, and any
// fixed panel color collides with some terminal theme. when the background is
// known, panel and selection colors are mixed from it instead: toward white
// on dark backgrounds, toward black on light ones
const DERIVED_SURFACES = {
  dark: { toward: 255, panel: 0.08, select: 0.2 },
  light: { toward: 0, panel: 0.06, select: 0.14 },
}

let terminalBackground = null

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

function mix(rgb, toward, amount) {
  return '#' + rgb.map((c) => Math.round(c + (toward - c) * amount).toString(16).padStart(2, '0')).join('')
}

function derivedSurfaces(name) {
  const rule = DERIVED_SURFACES[name]
  const rgb = hexToRgb(terminalBackground)
  if (!rule || !rgb) return null
  // a palette forced onto the opposite kind of background keeps its constants
  const [r, g, b] = rgb
  const side = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'light' : 'dark'
  if (side !== name) return null
  return { panelBg: mix(rgb, rule.toward, rule.panel), selectBg: mix(rgb, rule.toward, rule.select) }
}

export let DEFAULT_ACCENT = PALETTES.dark.accent
export let FG = PALETTES.dark.fg
export let FG_SOFT = PALETTES.dark.fgSoft
export let MUTED = PALETTES.dark.muted
export let PANEL_BG = PALETTES.dark.panelBg
export let SELECT_BG = PALETTES.dark.selectBg
export let RED = PALETTES.dark.red
export let GREEN = PALETTES.dark.green
export let PEER = PALETTES.dark.peer
export let HIGHLIGHT = PALETTES.dark.highlight

let currentPalette = 'dark'
let explicitAccent = null

const [accentValue, setAccentValue] = createSignal(DEFAULT_ACCENT)

export const accent = accentValue

export function setAccent(color) {
  explicitAccent = color || null
  setAccentValue(explicitAccent || DEFAULT_ACCENT)
}

export function setPalette(name) {
  currentPalette = PALETTES[name] ? name : 'dark'
  const p = PALETTES[currentPalette]
  DEFAULT_ACCENT = p.accent
  FG = p.fg
  FG_SOFT = p.fgSoft
  MUTED = p.muted
  const derived = derivedSurfaces(currentPalette)
  PANEL_BG = derived?.panelBg ?? p.panelBg
  SELECT_BG = derived?.selectBg ?? p.selectBg
  RED = p.red
  GREEN = p.green
  PEER = p.peer
  HIGHLIGHT = p.highlight
  setAccentValue(explicitAccent || p.accent)
}

// the terminal's background as '#rrggbb', or null when unknown. re-applies
// the current palette so derived surfaces follow it
export function setTerminalBackground(hex) {
  terminalBackground = hexToRgb(hex) ? hex.toLowerCase() : null
  setPalette(currentPalette)
}

export function getTerminalBackground() {
  return terminalBackground
}

export function paletteName() {
  return currentPalette
}

export function paletteList() {
  return Object.entries(PALETTES).map(([key, p]) => ({ key, desc: p.desc }))
}

export function shikiTheme() {
  return PALETTES[currentPalette].shiki
}
