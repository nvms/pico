import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOsc11, themeFromColorfgbg } from '../src/core/terminal-theme.js'
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
  assert.equal(theme.accent(), '#0f9d63')

  theme.setAccent('#60a5fa')
  setPalette('dark')
  assert.equal(theme.FG, '#e5e7eb')
  assert.equal(theme.accent(), '#60a5fa')

  theme.setAccent(null)
  assert.equal(theme.accent(), theme.DEFAULT_ACCENT)

  setPalette('nonsense')
  assert.equal(paletteName(), 'dark')
})

test('every palette declares the full color set and a shiki theme', () => {
  const keys = theme.paletteList().map((p) => p.key)
  assert.ok(keys.includes('nord'))
  for (const key of keys) {
    setPalette(key)
    assert.equal(paletteName(), key)
    for (const value of [theme.FG, theme.FG_SOFT, theme.MUTED, theme.FAINT, theme.PANEL_BG, theme.SELECT_BG, theme.RED, theme.HIGHLIGHT, theme.DEFAULT_ACCENT]) {
      assert.match(value, /^#[0-9a-fA-F]{6}$/)
    }
    assert.equal(typeof theme.shikiTheme(), 'string')
  }
  setPalette('dark')
})
