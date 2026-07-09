import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractImagePaths, mediaTypeFor, buildUserContent, finalizeUserContent, splitTextByImagePaths, placeholderizeImagePaths, inputTextFromContent } from '../src/ui/attachments.js'
import { hydrateImages } from '../src/core/agent.js'

const yes = () => true

test('extractImagePaths handles plain, quoted, escaped, and file:// forms', () => {
  assert.deepEqual(extractImagePaths('/tmp/shot.png', yes), ['/tmp/shot.png'])
  assert.deepEqual(extractImagePaths("'/tmp/my shot.png'", yes), ['/tmp/my shot.png'])
  assert.deepEqual(extractImagePaths('/tmp/my\\ shot.png', yes), ['/tmp/my shot.png'])
  assert.deepEqual(extractImagePaths('file:///tmp/a%20b.jpeg', yes), ['/tmp/a b.jpeg'])
  assert.deepEqual(extractImagePaths('/tmp/a.png /tmp/b.webp', yes), ['/tmp/a.png', '/tmp/b.webp'])
})

test('extractImagePaths rejects prose, non-images, and missing files', () => {
  assert.deepEqual(extractImagePaths('look at this text', yes), [])
  assert.deepEqual(extractImagePaths('/tmp/notes.txt', yes), [])
  assert.deepEqual(extractImagePaths('/tmp/shot.png', () => false), [])
  assert.deepEqual(extractImagePaths('see /tmp/shot.png please', yes), [])
})

test('buildUserContent interleaves text and images in order', () => {
  const attachments = new Map([
    ['[Image #1]', { path: '/tmp/a.png', mediaType: 'image/png' }],
    ['[Image #2]', { path: '/tmp/b.png', mediaType: 'image/png' }],
  ])
  const { content, used } = buildUserContent('first [Image #1] then [Image #2] done', attachments)
  assert.deepEqual(content.map((p) => p.type), ['text', 'image', 'text', 'image', 'text'])
  assert.equal(content[0].text, 'first ')
  assert.equal(content[1].source.path, '/tmp/a.png')
  assert.equal(content[2].text, ' then ')
  assert.deepEqual(used, ['[Image #1]', '[Image #2]'])
})

test('buildUserContent leaves plain text and stale placeholders alone', () => {
  const { content } = buildUserContent('no images here', new Map())
  assert.equal(content, 'no images here')
  const stale = buildUserContent('ghost [Image #9] token', new Map())
  assert.equal(stale.content, 'ghost [Image #9] token')
})

test('literal image paths in message text become attachments at send time', () => {
  const parts = splitTextByImagePaths('what is this image /Users/x/Screenshot\\ 2026.png thanks', yes)
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image', 'text'])
  assert.equal(parts[1].source.path, '/Users/x/Screenshot 2026.png')

  const quoted = splitTextByImagePaths('"/Users/x/my shot.jpeg" please', yes)
  assert.equal(quoted[0].source.path, '/Users/x/my shot.jpeg')

  assert.equal(splitTextByImagePaths('look at /Users/x/notes.txt', yes), null)
  assert.equal(splitTextByImagePaths('/Users/x/gone.png', () => false), null)

  const { content } = finalizeUserContent('see /Users/x/a.png here', new Map(), yes)
  assert.deepEqual(content.map((p) => p.type), ['text', 'image', 'text'])
  const plain = finalizeUserContent('no images here', new Map(), yes)
  assert.equal(plain.content, 'no images here')
})

test('macos narrow no-break space in screenshot names is a path character', () => {
  const path = '/Users/x/Screenshot\\ 2026-07-08\\ at\\ 9.48.15 PM.png'
  const parts = splitTextByImagePaths(path, yes)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].source.path, '/Users/x/Screenshot 2026-07-08 at 9.48.15 PM.png')
  assert.deepEqual(extractImagePaths(path, yes), ['/Users/x/Screenshot 2026-07-08 at 9.48.15 PM.png'])
})

test('placeholderizeImagePaths swaps completed paths for placeholders', () => {
  const attachments = new Map()
  let id = 0
  const result = placeholderizeImagePaths('look at /Users/x/a.png now', {
    attachments,
    nextId: () => ++id,
    exists: yes,
  })
  assert.equal(result.text, 'look at [Image #1] now')
  assert.equal(attachments.get('[Image #1]').path, '/Users/x/a.png')

  const untouched = placeholderizeImagePaths('just words', { attachments, nextId: () => ++id, exists: yes })
  assert.equal(untouched.changed, false)
  assert.equal(untouched.text, 'just words')
})

test('inputTextFromContent rebuilds placeholders from persisted content', () => {
  const attachments = new Map()
  let id = 10
  const text = inputTextFromContent(
    [
      { type: 'text', text: 'what is ' },
      { type: 'image', source: { kind: 'path', path: '/Users/x/shot.png', mediaType: 'image/png' } },
      { type: 'text', text: ' about' },
    ],
    { attachments, nextId: () => ++id },
  )
  assert.equal(text, 'what is [Image #11] about')
  assert.equal(attachments.get('[Image #11]').path, '/Users/x/shot.png')
  assert.equal(inputTextFromContent('plain text', { attachments, nextId: () => ++id }), 'plain text')
})

test('hydrateImages converts path parts to base64 and degrades gracefully', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-img-'))
  const img = join(dir, 'x.png')
  await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const history = [
    { role: 'user', content: 'plain' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look ' },
        { type: 'image', source: { kind: 'path', path: img, mediaType: 'image/png' } },
        { type: 'image', source: { kind: 'path', path: join(dir, 'missing.png'), mediaType: 'image/png' } },
      ],
    },
  ]
  const hydrated = await hydrateImages(history)
  assert.equal(hydrated[0].content, 'plain')
  assert.equal(hydrated[1].content[1].source.kind, 'base64')
  assert.equal(hydrated[1].content[1].source.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
  assert.match(hydrated[1].content[2].text, /image unavailable/)
  assert.equal(mediaTypeFor('a.JPG'), 'image/jpeg')
})
