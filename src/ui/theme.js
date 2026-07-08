import { createSignal } from '@trendr/core'

export const DEFAULT_ACCENT = '#6BE795'

const [accentValue, setAccentValue] = createSignal(DEFAULT_ACCENT)

export const accent = accentValue

export function setAccent(color) {
  setAccentValue(color || DEFAULT_ACCENT)
}

export const FG = '#e5e7eb'
export const FG_SOFT = '#9ca3af'
export const MUTED = '#6b7280'
export const FAINT = '#4b5563'
export const PANEL_BG = '#1e1e22'
export const SELECT_BG = '#374151'
export const RED = '#f87171'
