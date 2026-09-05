import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydrateImages, compactionHistory } from '../src/agent.js'
import { imageDimensions, IMAGE_LIMITS } from '../src/images.js'

const image = (data) => ({ type: 'image', source: { kind: 'base64', mediaType: 'image/jpeg', data: data.toString('base64') } })
const png = (width, height) => sharp({ create: { width, height, channels: 3, background: 'white' } }).png().toBuffer()
const dimensions = part => sharp(Buffer.from(part.source.data, 'base64')).metadata()

test('patch rounding is bounded for square, tall, wide and thin images', () => {
  for (const [w, h] of [[4096, 4096], [1440, 27000], [27000, 1440], [1, 100000], [100000, 1], [33, 48000]]) {
    const d = imageDimensions(w, h)
    assert.ok(d.width <= 2000 && d.height <= 2000)
    assert.ok(Math.ceil(d.width / 32) * Math.ceil(d.height / 32) <= 1536)
    assert.ok(d.width <= w && d.height <= h)
  }
})

test('oversized historical paths and base64 are resized without altering originals, including compaction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-image-safety-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bytes = await png(1440, 27000)
  const path = join(dir, 'screenshot.png')
  await writeFile(path, bytes)
  const history = [
    { role: 'user', content: [{ type: 'image', source: { kind: 'path', path } }] },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: [image(bytes)] },
  ]
  const original = structuredClone(history)
  for (const result of [await hydrateImages(history), await compactionHistory(history, 'summarize')]) {
    for (const index of [0, 2]) {
      const part = result[index].content[0]
      const meta = await dimensions(part)
      assert.equal(meta.height, 2000)
      assert.ok(Math.ceil(meta.width / 32) * Math.ceil(meta.height / 32) <= 1536)
      assert.equal(part.source.mediaType, 'image/png')
    }
  }
  assert.deepEqual(history, original)
  assert.deepEqual(await readFile(path), bytes)
})

test('corrupt, truncated, empty, unsupported and remote images become recoverable text', async () => {
  const good = await png(100, 100)
  const parts = [image(Buffer.alloc(0)), image(Buffer.from('not an image')), image(good.subarray(0, 50)),
    { type: 'image', source: { kind: 'base64', data: '!invalid!' } },
    { type: 'image', source: { kind: 'url', url: 'https://example.com/image.png' } },
    { type: 'image' }]
  const [message] = await hydrateImages([{ role: 'user', content: parts }])
  for (const part of message.content) {
    assert.equal(part.type, 'text')
    assert.match(part.text, /image unavailable.*Original unchanged.*smaller crop/)
  }
})

test('data URLs are validated and small images retain dimensions', async () => {
  const bytes = await png(16, 24)
  const [message] = await hydrateImages([{ role: 'user', content: [{ type: 'image', source: { kind: 'url', url: `data:image/png;base64,${bytes.toString('base64')}` } }] }])
  assert.equal((await dimensions(message.content[0])).height, 24)
})

test('request count retains newest images and leaves history intact', async () => {
  const part = image(await png(8, 8))
  const history = Array.from({ length: 25 }, () => ({ role: 'user', content: [part] }))
  const result = await hydrateImages(history)
  assert.equal(result.filter(m => m.content[0].type === 'image').length, IMAGE_LIMITS.count)
  assert.match(result[0].content[0].text, /count safety budget/)
  assert.equal(result.at(-1).content[0].type, 'image')
  assert.ok(history.every(m => m.content[0] === part))
})

test('request patch budget bounds many individually valid images', async () => {
  const part = image(await png(1024, 1024))
  const result = await hydrateImages([{ role: 'user', content: Array(15).fill(part) }])
  const images = result[0].content.filter(p => p.type === 'image')
  assert.equal(images.length, 11)
  assert.ok(images.length * 1024 <= IMAGE_LIMITS.requestPatches)
  assert.match(result[0].content[0].text, /request image safety budget/)
})

test('EXIF orientation is applied before sizing and removed on output', async () => {
  const bytes = await sharp(await png(40, 80)).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  const [message] = await hydrateImages([{ role: 'user', content: [image(bytes)] }])
  const meta = await dimensions(message.content[0])
  assert.equal(meta.width, 80)
  assert.equal(meta.height, 40)
  assert.equal(meta.orientation, undefined)
})

test('large encoded images use a bounded JPEG fallback', async () => {
  const { randomBytes } = await import('node:crypto')
  const bytes = await sharp(randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer()
  assert.ok(bytes.length > IMAGE_LIMITS.bytes)
  const [message] = await hydrateImages([{ role: 'user', content: [image(bytes)] }])
  assert.equal(message.content[0].source.mediaType, 'image/jpeg')
  assert.ok(Buffer.from(message.content[0].source.data, 'base64').length < IMAGE_LIMITS.bytes)
})

test('a FIFO image is rejected without waiting for a writer', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'pico-fifo-'))
  try {
    const path = join(dir, 'image.png')
    execFileSync('mkfifo', [path])
    const [message] = await hydrateImages([{ role: 'user', content: [{ type: 'image', source: { kind: 'path', path } }] }])
    assert.equal(message.content[0].type, 'text')
    assert.match(message.content[0].text, /not a regular image file/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
