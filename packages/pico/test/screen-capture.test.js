import test from 'node:test'
import assert from 'node:assert/strict'
import { captureCommands, captureRegion } from '../src/screen-capture.js'

test('region capture selects native platform commands', () => {
  assert.deepEqual(captureCommands('darwin', '/tmp/image.png'), [['screencapture', ['-i', '-x', '/tmp/image.png']]])
  assert.equal(captureCommands('linux', '/tmp/image.png', { XDG_SESSION_TYPE: 'x11' })[0][0], 'xfce4-screenshooter')
  assert.equal(captureCommands('linux', '/tmp/image.png', { XDG_SESSION_TYPE: 'wayland' })[0][0], 'gnome-screenshot')
  assert.throws(() => captureCommands('win32', '/tmp/image.png'), /macOS or Linux/)
})

test('Linux capture returns an attachment with disposal', async () => {
  let invocation
  const result = await captureRegion({ platform: 'linux', env: {}, exists: () => true, run: (command, args, done) => { invocation = [command, args]; done(null) } })
  assert.equal(invocation[0], 'xfce4-screenshooter')
  assert.deepEqual(invocation[1], ['--region', '--save', result.path])
  assert.equal(typeof result.dispose, 'function')
  await result.dispose()
})

test('missing backend falls back, but user cancellation does not', async () => {
  const calls = []
  const result = await captureRegion({ platform: 'linux', env: {}, exists: () => false, run: (command, args, done) => {
    calls.push(command)
    done(Object.assign(new Error('cancelled'), { code: calls.length === 1 ? 'ENOENT' : 1 }))
  } })
  assert.equal(result, null)
  assert.deepEqual(calls, ['xfce4-screenshooter', 'gnome-screenshot'])
})

test('missing Linux tools produce installation guidance', async () => {
  await assert.rejects(captureRegion({ platform: 'linux', env: {}, run: (command, args, done) => done(Object.assign(new Error('missing'), { code: 'ENOENT' })) }), /apt install xfce4-screenshooter/)
})

test('Linux backend failures are surfaced', async () => {
  await assert.rejects(captureRegion({ platform: 'linux', env: {}, exists: () => false, run: (command, args, done) => done(Object.assign(new Error('cannot open display'), { code: 2 })) }), /cannot open display/)
})
