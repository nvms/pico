import assert from 'node:assert/strict'
import test from 'node:test'
import { createScreenCaptureInput } from '../src/ui/screen-capture-input.js'

test('attaches a captured image at the cursor', async () => {
  let draft = { value: 'look here', cursor: 4, session: {}, revision: 1 }
  const capture = createScreenCaptureInput({
    captureRegion: async () => ({ path: '/tmp/capture.png', dispose: async () => {} }),
    getDraft: () => draft,
    attachImage: (path) => path === '/tmp/capture.png' ? '[Image #1]' : null,
    setInput: (value, cursor) => { draft = { ...draft, value, cursor, revision: 2 } },
    onError: assert.fail,
  })

  await capture()

  assert.equal(draft.value, 'look[Image #1] here')
  assert.equal(draft.cursor, 14)
})

test('disposes a capture when the draft changes', async () => {
  let draft = { value: 'before', cursor: 6, session: {}, revision: 1 }
  let resolveCapture
  let disposed = false
  const capture = createScreenCaptureInput({
    captureRegion: () => new Promise((resolve) => { resolveCapture = resolve }),
    getDraft: () => draft,
    attachImage: () => assert.fail('capture should not attach'),
    setInput: () => assert.fail('input should not change'),
    onError: (message) => assert.equal(message, 'Screen capture not attached: the draft changed'),
  })

  const pending = capture()
  draft = { ...draft, value: 'after', revision: 2 }
  resolveCapture({ path: '/tmp/capture.png', dispose: async () => { disposed = true } })
  await pending

  assert.equal(disposed, true)
})

test('does nothing when capture is cancelled', async () => {
  const statuses = []
  const capture = createScreenCaptureInput({
    captureRegion: async () => null,
    onStatus: (status) => statuses.push(status),
    getDraft: () => ({ value: '', cursor: 0, session: null, revision: 0 }),
    attachImage: () => assert.fail('capture should not attach'),
    setInput: () => assert.fail('input should not change'),
    onError: assert.fail,
  })

  await capture()
  assert.deepEqual(statuses, ['capturing', 'idle'])
})
