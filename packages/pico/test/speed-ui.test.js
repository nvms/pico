import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundle = await build({
  stdin: {
    contents: "export { SpeedPanel } from './src/ui/panels.jsx'; export { mount } from '@trendr/core'; export { jsx } from '@trendr/core/jsx-runtime'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  plugins: [{
    name: 'external-core',
    setup(build) {
      build.onResolve({ filter: /^picocode-core\// }, args => ({ path: import.meta.resolve(args.path), external: true }))
    },
  }],
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: '@trendr/core',
})
const { SpeedPanel, mount, jsx } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

async function picker(t) {
  const stdin = new PassThrough()
  const stream = new PassThrough()
  stream.columns = 80
  stream.rows = 24
  let rendered = ''
  stream.on('data', chunk => { rendered += chunk })
  const selections = []
  const defaults = []
  let closed = false
  const app = mount(() => jsx(SpeedPanel, {
    levels: [{ key: 'standard', usage: '1x usage' }, { key: 'fast', usage: '2.5x usage' }],
    current: 'fast', defaultLevel: 'standard', focused: true,
    onPick: level => selections.push(level.key),
    onPickDefault: level => defaults.push(level.key),
    onClose: () => { closed = true },
  }), { stream, stdin })
  t.after(() => { app.unmount(); stdin.destroy(); stream.destroy() })
  await delay(30)
  return {
    selections, defaults, rendered: () => rendered, closed: () => closed,
    async key(value) { stdin.write(value); await delay(30) },
  }
}

test('speed picker selects requested speed for this session', async t => {
  const ui = await picker(t)
  assert.match(ui.rendered(), /2\.5x included usage/)
  await ui.key('\r')
  assert.deepEqual(ui.selections, ['fast'])
  assert.deepEqual(ui.defaults, [])
})

test('speed picker saves defaults only with ctrl+s', async t => {
  const ui = await picker(t)
  await ui.key('k')
  await ui.key('\x13')
  assert.deepEqual(ui.defaults, ['standard'])
  assert.deepEqual(ui.selections, [])
})

test('escape closes speed picker without applying', async t => {
  const ui = await picker(t)
  await ui.key('\x1b')
  assert.equal(ui.closed(), true)
  assert.deepEqual(ui.selections, [])
  assert.deepEqual(ui.defaults, [])
})
