import test from 'node:test'
import assert from 'node:assert/strict'
import { createComposerFiles } from '../src/ui/composer-files.js'
import { buildUserContent } from 'picocode-core/attachments.js'

const path = '/project/My Notes/app.js'
const attachments = new Map([
  ['[File #1]', { kind: 'file', path }],
  ['[File #2]', { kind: 'selection', path, text: 'hello', fromLine: 1, toLine: 1 }],
  ['[Image #3]', { path: '/project/image.png', mediaType: 'image/png' }],
])

test('shows a path while submitting the original file attachment', () => {
  const composer = createComposerFiles()
  assert.equal(composer.update('read [File #1] please', attachments), `read ${path} please`)
  assert.deepEqual(buildUserContent(composer.content(), attachments).content, [
    { type: 'text', text: 'read ' },
    { type: 'file', path },
    { type: 'text', text: ' please' },
  ])
})

test('keeps references through surrounding edits and repeated picks', () => {
  const composer = createComposerFiles()
  composer.update('[File #1]', attachments)
  composer.update(`read ${path}`, attachments)
  composer.update(`read ${path} please`, attachments)
  composer.update(`read ${path} please [File #1]`, attachments)
  assert.equal(composer.content(), 'read [File #1] please [File #1]')
  composer.update(`read ${path} please ${path}!`, attachments)
  assert.equal(composer.content(), 'read [File #1] please [File #1]!')
})

test('editing a file path turns it into ordinary editable text', () => {
  const composer = createComposerFiles()
  composer.update('[File #1]', attachments)
  const changed = path.replace('app.js', 'other.js')
  composer.update(changed, attachments)
  assert.equal(composer.content(), changed)
})

test('does not attach manually typed paths or retain deleted references', () => {
  const composer = createComposerFiles()
  composer.update(`[File #1] ${path}`, attachments)
  assert.equal(composer.content(), `[File #1] ${path}`)
  composer.update('', attachments)
  composer.update(path, attachments)
  assert.equal(composer.content(), path)
})

test('leaves image, selection, and stale placeholders unchanged', () => {
  const composer = createComposerFiles()
  const text = '[File #2] [Image #3] [File #99]'
  assert.equal(composer.update(text, attachments), text)
  assert.equal(composer.content(), text)
})

test('expands multiple file references with correct positions', () => {
  const composer = createComposerFiles()
  const text = '[File #1] then [File #1]'
  assert.equal(composer.update(text, attachments), `${path} then ${path}`)
  assert.equal(composer.content(), text)
  composer.update(`prefix ${path} then ${path}`, attachments)
  assert.equal(composer.content(), `prefix ${text}`)
})
