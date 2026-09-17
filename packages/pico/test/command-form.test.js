import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { commandFields } from '../src/ui/composer-commands.js'
import { parseCommandArguments } from 'picocode-core/commands.js'

const bundle = await build({
  stdin: {
    contents: "export { CommandForm } from './src/ui/command-form.jsx'; export { mount } from '@trendr/core'; export { jsx } from '@trendr/core/jsx-runtime'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: '@trendr/core',
})
const { CommandForm, mount, jsx } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

async function form(t, body) {
  const stdin = new PassThrough()
  const stream = new PassThrough()
  stream.columns = 80
  stream.rows = 24
  stream.resume()
  const submissions = []
  let cancelled = false
  const app = mount(() => jsx(CommandForm, {
    name: 'review',
    fields: commandFields({ arguments: parseCommandArguments(body) }, body),
    files: ['src/app.js', 'src/test.js'],
    focused: true,
    onSubmit: (values) => submissions.push(values),
    onCancel: () => { cancelled = true },
  }), { stream, stdin })
  t.after(() => { app.unmount(); stdin.destroy(); stream.destroy() })
  await delay(30)
  return {
    submissions,
    cancelled: () => cancelled,
    async key(text) { stdin.write(text); await delay(30) },
  }
}

test('command form collects path, choice, text, and legacy arguments in sequence', async (t) => {
  const ui = await form(t, '{{file:path}} {{mode:choice(review,fix)}} {{focus:text}} $ARGUMENTS')
  await ui.key('app')
  await ui.key('\r')
  await ui.key('\x1b[B')
  await ui.key('\r')
  await ui.key('correctness')
  await ui.key('\r')
  assert.deepEqual(ui.submissions, [])
  await ui.key('extra context')
  await ui.key('\r')
  assert.deepEqual(ui.submissions, [{ file: 'src/app.js', mode: 'fix', focus: 'correctness', $args: 'extra context' }])
})

test('escape cancels the form without submitting', async (t) => {
  const ui = await form(t, '{{focus:text}}')
  await ui.key('unfinished')
  await ui.key('\x1b')
  await delay(50)
  assert.equal(ui.cancelled(), true)
  assert.deepEqual(ui.submissions, [])
})
