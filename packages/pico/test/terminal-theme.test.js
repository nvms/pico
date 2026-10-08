import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOsc11, parseOsc11Background, themeFromColorfgbg } from 'picocode-core/terminal-theme.js'
import { setPalette, paletteName, FG, PANEL_BG } from '../src/ui/theme.js'
import * as theme from '../src/ui/theme.js'

test('parseOsc11 reads 16-bit and 8-bit channel replies', () => {
  assert.equal(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), 'light')
  assert.equal(parseOsc11('\x1b]11;rgb:1e1e/1e1e/2222\x07'), 'dark')
  assert.equal(parseOsc11('\x1b]11;rgb:ff/ff/ff\x07'), 'light')
  assert.equal(parseOsc11('garbage'), null)
})

test('themeFromColorfgbg maps standard bg codes', () => {
  assert.equal(themeFromColorfgbg('0;15'), 'light')
  assert.equal(themeFromColorfgbg('15;0'), 'dark')
  assert.equal(themeFromColorfgbg('12;8;7'), 'light')
  assert.equal(themeFromColorfgbg(''), null)
  assert.equal(themeFromColorfgbg(undefined), null)
})

test('setPalette swaps live bindings and falls back to dark', () => {
  setPalette('light')
  assert.equal(paletteName(), 'light')
  assert.equal(theme.FG, '#1f2430')
  assert.equal(theme.PANEL_BG, '#e9e9ee')
  assert.equal(theme.accent(), theme.DEFAULT_ACCENT)

  theme.setAccent('#60a5fa')
  setPalette('dark')
  assert.equal(theme.FG, '#e5e7eb')
  assert.equal(theme.accent(), '#60a5fa')

  theme.setAccent(null)
  assert.equal(theme.accent(), theme.DEFAULT_ACCENT)

  setPalette('nonsense')
  assert.equal(paletteName(), 'dark')
})

test('default palettes use purple accents without changing error colors', () => {
  theme.setAccent(null)
  try {
    for (const [palette, accent, red] of [
      ['dark', '#a78bfa', '#f87171'],
      ['light', '#7c3aed', '#dc2626'],
    ]) {
      setPalette(palette)
      assert.equal(theme.DEFAULT_ACCENT, accent)
      assert.equal(theme.accent(), accent)
      assert.equal(theme.RED, red)
    }
  } finally {
    setPalette('dark')
  }
})

test('every palette declares the full color set and a shiki theme', () => {
  const keys = theme.paletteList().map((p) => p.key)
  assert.ok(keys.includes('nord'))
  for (const key of keys) {
    setPalette(key)
    assert.equal(paletteName(), key)
    for (const value of [theme.FG, theme.FG_SOFT, theme.MUTED, theme.PANEL_BG, theme.SELECT_BG, theme.RED, theme.PEER, theme.HIGHLIGHT, theme.DEFAULT_ACCENT]) {
      assert.match(value, /^#[0-9a-fA-F]{6}$/)
    }
    assert.equal(typeof theme.shikiTheme(), 'string')
  }
  setPalette('dark')
})

test('secondary text maintains readable contrast on theme surfaces', () => {
  function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(value => {
      const channel = parseInt(value, 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  try {
    for (const { key } of theme.paletteList()) {
      setPalette(key)
      for (const background of [theme.PANEL_BG, theme.SELECT_BG]) {
        const values = [luminance(theme.MUTED), luminance(background)].sort((a, b) => a - b)
        assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, `${key} secondary text on ${background}`)
      }
    }
  } finally {
    setPalette('dark')
  }
})


test('peer color is independent of session accent', () => {
  for (const { key } of theme.paletteList()) {
    setPalette(key)
    const color = theme.PEER
    theme.setAccent('#123456')
    assert.equal(theme.PEER, color)
    assert.notEqual(theme.PEER, theme.accent())
  }
  theme.setAccent(null)
  setPalette('dark')
})

test('parseOsc11Background reports the color as hex', () => {
  assert.equal(parseOsc11Background('\x1b]11;rgb:1e1e/1d1d/2424\x1b\\'), '#1e1d24')
  assert.equal(parseOsc11Background('\x1b]11;rgb:f7/f6/fb\x07'), '#f7f6fb')
  assert.equal(parseOsc11Background('garbage'), null)
})

test('panel surfaces derive from the terminal background', () => {
  theme.setTerminalBackground('#1e1d24')
  setPalette('dark')
  assert.equal(theme.PANEL_BG, '#302f36')
  assert.equal(theme.SELECT_BG, '#4b4a50')

  setPalette('light')
  assert.equal(theme.PANEL_BG, '#e9e9ee', 'light palette on a dark terminal keeps its constant')

  theme.setTerminalBackground('#f7f6fb')
  assert.equal(theme.PANEL_BG, '#e8e7ec', 're-applies the current palette')
  assert.equal(theme.SELECT_BG, '#d4d4d8')

  setPalette('nord')
  assert.equal(theme.PANEL_BG, '#3b4252', 'named themes keep their own surfaces')

  theme.setTerminalBackground(null)
  setPalette('dark')
  assert.equal(theme.PANEL_BG, '#1e1e22', 'unknown background falls back to the palette')
})
