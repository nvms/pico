import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { readClipboardImage } from '../src/clipboard.js'
import { createClipboardInput } from '../src/ui/clipboard-input.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

for (const platform of ['darwin', 'win32', 'linux']) {
  for (const wayland of platform === 'linux' ? [false, true] : [false]) {
    test(`reads and cleans up clipboard PNG on ${platform}${wayland ? ' Wayland' : ''}`, async () => {
      const calls = []
      const image = await readClipboardImage({
        platform, env: wayland ? { WAYLAND_DISPLAY: 'wayland-0' } : {},
        run: async (command, args, options) => {
          calls.push({ command, args, options })
          return { stdout: platform !== 'linux' ? Buffer.from(png.toString('base64')) : calls.length === 1 ? Buffer.from('text/plain\nimage/png\n') : png }
        },
      })
      try {
        assert.deepEqual(await readFile(image.path), png)
        assert.equal(calls[0].command, platform === 'darwin' ? 'osascript' : platform === 'win32' ? 'powershell.exe' : wayland ? 'wl-paste' : 'xclip')
        assert.equal(calls[0].options.timeout, 10000)
      } finally { await image.dispose() }
      await assert.rejects(stat(image.path), { code: 'ENOENT' })
    })
  }
}

test('empty clipboard, remote sessions, and missing readers', async () => {
  assert.equal(await readClipboardImage({ platform: 'darwin', env: {}, run: async () => ({ stdout: Buffer.alloc(0) }) }), null)
  await assert.rejects(readClipboardImage({ env: { SSH_TTY: 'tty' } }), /SSH/)
  await assert.rejects(readClipboardImage({ platform: 'linux', env: {}, run: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }) } }), /install xclip/)
  await assert.rejects(readClipboardImage({ platform: 'darwin', env: {}, run: async () => ({ stdout: Buffer.from('bm90IGFuIGltYWdl') }) }), /PNG/)
})

function composer() {
  let resolve
  const draft = { value: 'before after', cursor: 7, revision: 0, session: {} }
  const errors = []
  const attached = []
  let disposed = false
  const paste = createClipboardInput({
    readImage: () => new Promise((done) => { resolve = done }),
    getDraft: () => ({ ...draft }),
    attachImage: (path) => { attached.push(path); return '[Image #1]' },
    setInput: (value, cursor) => Object.assign(draft, { value, cursor }),
    onError: (error) => errors.push(error),
  })
  return { draft, errors, attached, paste, disposed: () => disposed, finish: () => resolve({ path: '/clipboard.png', dispose: async () => { disposed = true } }) }
}

test('inserts one attachment at the cursor without sending', async () => {
  const ui = composer()
  const pending = ui.paste()
  await ui.paste()
  ui.finish()
  await pending
  assert.equal(ui.draft.value, 'before [Image #1]after')
  assert.equal(ui.draft.cursor, 17)
  assert.deepEqual(ui.attached, ['/clipboard.png'])
  assert.deepEqual(ui.errors, [])
})

for (const change of ['value', 'cursor', 'revision', 'session']) {
  test(`discards clipboard result after ${change} changes`, async () => {
    const ui = composer()
    const pending = ui.paste()
    ui.draft[change] = change === 'value' ? 'changed' : change === 'session' ? {} : 42
    ui.finish()
    await pending
    assert.equal(ui.disposed(), true)
    assert.deepEqual(ui.attached, [])
    assert.match(ui.errors[0], /draft changed/)
  })
}
