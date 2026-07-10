import { createSignal } from '@trendr/core'

const PALETTES = {
  dark: {
    desc: 'light text for dark terminals',
    accent: '#6BE795',
    fg: '#e5e7eb',
    fgSoft: '#9ca3af',
    muted: '#6b7280',
    faint: '#4b5563',
    panelBg: '#1e1e22',
    selectBg: '#374151',
    red: '#f87171',
    highlight: '#ffffff',
    shiki: 'nord',
  },
  light: {
    desc: 'dark text for light terminals',
    accent: '#0f9d63',
    fg: '#1f2430',
    fgSoft: '#4b5563',
    muted: '#6b7280',
    faint: '#a3a8b3',
    panelBg: '#e9e9ee',
    selectBg: '#d4d4dc',
    red: '#dc2626',
    highlight: '#111827',
    shiki: 'github-light',
  },
  nord: {
    desc: 'arctic blues on polar night',
    accent: '#88c0d0',
    fg: '#d8dee9',
    fgSoft: '#aab2c4',
    muted: '#7b88a1',
    faint: '#616e88',
    panelBg: '#3b4252',
    selectBg: '#434c5e',
    red: '#bf616a',
    highlight: '#eceff4',
    shiki: 'nord',
  },
}

export let DEFAULT_ACCENT = PALETTES.dark.accent
export let FG = PALETTES.dark.fg
export let FG_SOFT = PALETTES.dark.fgSoft
export let MUTED = PALETTES.dark.muted
export let FAINT = PALETTES.dark.faint
export let PANEL_BG = PALETTES.dark.panelBg
export let SELECT_BG = PALETTES.dark.selectBg
export let RED = PALETTES.dark.red
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
  FAINT = p.faint
  PANEL_BG = p.panelBg
  SELECT_BG = p.selectBg
  RED = p.red
  HIGHLIGHT = p.highlight
  setAccentValue(explicitAccent || p.accent)
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
