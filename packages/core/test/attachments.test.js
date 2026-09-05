import sharp from 'sharp'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractImagePaths, mediaTypeFor, buildUserContent, finalizeUserContent, splitTextByImagePaths, placeholderizeImagePaths, inputTextFromContent } from '../src/attachments.js'
import { compactionHistory, hydrateImages } from '../src/agent.js'

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

test('selection placeholders preserve their position and restore', async () => {
  const attachments = new Map([
    ['[File #1]', { kind: 'selection', path: '/tmp/app.js', text: 'const answer = 42', fromLine: 7, toLine: 7 }],
  ])
  const built = buildUserContent('change [File #1] without moving it', attachments)
  assert.deepEqual(built.content.map((part) => part.type), ['text', 'selection', 'text'])
  assert.deepEqual(built.content[1], { type: 'selection', path: '/tmp/app.js', text: 'const answer = 42', fromLine: 7, toLine: 7 })

  const restored = new Map()
  const text = inputTextFromContent(built.content, { attachments: restored, nextId: () => 2 })
  assert.equal(text, 'change [File #2] without moving it')
  assert.deepEqual(restored.get('[File #2]'), attachments.get('[File #1]'))

  const hydrated = await hydrateImages([{ role: 'user', content: built.content }])
  assert.match(hydrated[0].content[1].text, /^\[selection: \/tmp\/app\.js:7-7\]\nconst answer = 42/)
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
  await writeFile(img, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer())

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
  assert.equal((await sharp(Buffer.from(hydrated[1].content[1].source.data, 'base64')).metadata()).width, 2)
  assert.match(hydrated[1].content[2].text, /image unavailable/)
  assert.equal(mediaTypeFor('a.JPG'), 'image/jpeg')
})

test('compaction history hydrates images and excludes system messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-compact-img-'))
  const img = join(dir, 'x.png')
  await writeFile(img, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer())

  const history = await compactionHistory([
    { role: 'system', content: 'system' },
    { role: 'user', content: [{ type: 'image', source: { kind: 'path', path: img, mediaType: 'image/png' } }] },
  ], 'summarize')

  assert.equal(history.length, 2)
  assert.equal(history[0].content[0].source.kind, 'base64')
  assert.deepEqual(history[1], { role: 'user', content: 'summarize' })
})

test('file placeholders become file parts and restore as placeholders', () => {
  const attachments = new Map([['[File #1]', { path: '/tmp/My Notes/plan.pdf', kind: 'file' }]])
  const { content } = buildUserContent('read [File #1] please', attachments)
  assert.deepEqual(content, [
    { type: 'text', text: 'read ' },
    { type: 'file', path: '/tmp/My Notes/plan.pdf' },
    { type: 'text', text: ' please' },
  ])
  const restored = new Map()
  let n = 0
  const text = inputTextFromContent(content, { attachments: restored, nextId: () => ++n })
  assert.equal(text, 'read [File #1] please')
  assert.deepEqual(restored.get('[File #1]'), { path: '/tmp/My Notes/plan.pdf', kind: 'file' })
})

test('stashImages copies each image into the directory and points the part at the copy', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { stashImages } = await import('../src/attachments.js')
  const src = await mkdtemp(join(tmpdir(), 'pico-img-'))
  const dir = join(await mkdtemp(join(tmpdir(), 'pico-att-')), 'session')
  const original = join(src, 'shot.png')
  await writeFile(original, 'png bytes')
  const content = [
    { type: 'text', text: 'look' },
    { type: 'image', source: { kind: 'path', path: original, mediaType: 'image/png' } },
  ]
  const stashed = await stashImages(content, dir)
  assert.equal(stashed[0], content[0])
  assert.notEqual(stashed[1].source.path, original)
  assert.ok(stashed[1].source.path.startsWith(dir))
  assert.ok(stashed[1].source.path.endsWith('-shot.png'))
  assert.equal(await readFile(stashed[1].source.path, 'utf-8'), 'png bytes')
  await rm(original)
  assert.equal(await readFile(stashed[1].source.path, 'utf-8'), 'png bytes')
  assert.deepEqual(await stashImages(stashed, dir), stashed)
  const missing = [{ type: 'image', source: { kind: 'path', path: join(src, 'gone.png'), mediaType: 'image/png' } }]
  assert.deepEqual(await stashImages(missing, dir), missing)
})

test('commit placeholders become commit parts and restore as attachments', async () => {
  const { buildUserContent, inputTextFromContent, commitLabel } = await import('../src/attachments.js')
  const attachments = new Map([['[File #1]', { kind: 'commit', hash: 'd59e0a5c0ffee', subject: 'keep the merge glyph', root: '/tmp/repo' }]])
  const built = buildUserContent('look at [File #1] please', attachments)
  assert.deepEqual(built.content, [
    { type: 'text', text: 'look at ' },
    { type: 'commit', hash: 'd59e0a5c0ffee', subject: 'keep the merge glyph', root: '/tmp/repo' },
    { type: 'text', text: ' please' },
  ])
  assert.equal(commitLabel(built.content[1]), '[commit: d59e0a5 "keep the merge glyph"]')
  const restored = new Map()
  let n = 0
  const text = inputTextFromContent(built.content, { attachments: restored, nextId: () => ++n })
  assert.equal(text, 'look at [File #1] please')
  assert.deepEqual(restored.get('[File #1]'), { hash: 'd59e0a5c0ffee', subject: 'keep the merge glyph', root: '/tmp/repo', kind: 'commit' })
})

test('a commit part hydrates into the commit itself for the model', async () => {
  const { hydrateCommit } = await import('../src/agent.js')
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'pico-commit-'))
  const run = (args) => execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@x.io', ...args], { cwd: dir }).toString().trim()
  run(['init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'a.txt'), 'hello\n')
  run(['add', 'a.txt'])
  run(['commit', '-qm', 'add greeting'])
  const hash = run(['rev-parse', 'HEAD'])
  const part = await hydrateCommit({ type: 'commit', hash, subject: 'add greeting', root: dir })
  assert.match(part.text, /^\[commit: [0-9a-f]{7} "add greeting"\]\n/)
  assert.match(part.text, /Author: Ada <ada@x.io>/)
  assert.match(part.text, /\+hello/)
  assert.match(part.text, /\[\/commit\]$/)
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(40) + '\n'.repeat(1) + Array.from({ length: 400 }, (_, i) => `line ${i} of a generated file that pads the patch`).join('\n'))
  run(['add', 'big.txt'])
  run(['commit', '-qm', 'add a big file'])
  const big = await hydrateCommit({ type: 'commit', hash: run(['rev-parse', 'HEAD']), subject: 'add a big file', root: dir })
  assert.match(big.text, /big\.txt \|/)
  assert.match(big.text, /\[patch omitted: \d+KB; run git show [0-9a-f]{7} -- <path>/)
  assert.doesNotMatch(big.text, /line 200 of a generated file/)
  const missing = await hydrateCommit({ type: 'commit', hash: 'ffffffff', subject: '', root: dir })
  assert.match(missing.text, /commit unavailable/)
})

test('element placeholders become element parts the model reads as markup', async () => {
  const { buildUserContent, inputTextFromContent, elementLabel } = await import('../src/attachments.js')
  const attachment = { kind: 'element', url: 'http://localhost:5174/settings', selector: 'form > button.save', tag: 'button', text: 'Save', html: '<button class="save">Save</button>', rect: { x: 1, y: 2, width: 3, height: 4 }, component: 'SettingsView' }
  const built = buildUserContent('why is [File #1] grey?', new Map([['[File #1]', attachment]]))
  assert.equal(built.content[1].type, 'element')
  assert.equal(built.content[1].selector, 'form > button.save')
  assert.equal(elementLabel(built.content[1]), '[element: <button> form > button.save on http://localhost:5174/settings in component SettingsView]\n<button class="save">Save</button>\n[/element]')
  assert.match(elementLabel({ ...built.content[1], styles: { color: 'red' }, rules: ['.save { color: red; }'] }), /computed style: color: red\nmatched css rules:\n\.save \{ color: red; \}\n\[\/element\]$/)
  const restored = new Map()
  let n = 0
  assert.equal(inputTextFromContent(built.content, { attachments: restored, nextId: () => ++n }), 'why is [File #1] grey?')
  assert.equal(restored.get('[File #1]').kind, 'element')
})

test('an empty image file hydrates as text, never as an image', async () => {
  const { hydrateImages } = await import('../src/agent.js')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'pico-empty-'))
  const file = join(dir, 'blank.png')
  await writeFile(file, '')
  const [message] = await hydrateImages([{ role: 'user', content: [{ type: 'image', source: { kind: 'path', path: file, mediaType: 'image/png' } }] }])
  const [part] = message.content
  assert.equal(part.type, 'text')
  assert.match(part.text, /is empty/)
})
