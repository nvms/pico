import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/ui/app.jsx', import.meta.url), 'utf8')
const commands = source.slice(source.indexOf('  function runCommand('), source.indexOf('  async function refreshAuthProviders('))

function harness({ busy = false, compacting = false, fork = async () => {} } = {}) {
  const flashes = []
  const calls = []
  const ctl = { fork: args => { calls.push(args); return fork(args) } }
  const run = new Function('busy', 'compacting', 'ctl', 'flash', 'setInput', 'setCmdCycle',
    `${commands.replaceAll('import.meta.url', JSON.stringify(import.meta.url))}\nreturn runCommand`)(() => busy, () => compacting, ctl, message => flashes.push(message), () => {}, () => {})
  return { run, flashes, calls }
}

for (const state of [{ busy: true }, { compacting: true }]) {
  test(`fork is refused locally while ${state.busy ? 'busy' : 'compacting'}`, async () => {
    const ui = harness(state)
    await ui.run({ name: 'fork' })
    assert.deepEqual(ui.calls, [])
    assert.deepEqual(ui.flashes, ['finish or interrupt the current turn first'])
  })
}

test('daemon fork rejection becomes a flash, not an unhandled rejection', async () => {
  const ui = harness({ fork: async () => { throw new Error('finish or interrupt the current turn first') } })
  await assert.doesNotReject(ui.run({ name: 'fork' }))
  assert.deepEqual(ui.calls, [''])
  assert.deepEqual(ui.flashes, ['finish or interrupt the current turn first'])
})

test('idle fork still dispatches successfully', async () => {
  const ui = harness()
  await ui.run({ name: 'fork' })
  assert.deepEqual(ui.calls, [''])
  assert.deepEqual(ui.flashes, [])
})
