import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory, memoryIndex, slugify } from '../src/memory.js'

async function fixture() {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  return mkdtemp(join(tmpdir(), 'pico-proj-'))
}

test('remember and recall round trip across scopes', async () => {
  const root = await fixture()
  const memory = createMemory(root)

  await memory.remember({ name: 'Flaky Auth Test!', description: 'auth test fails on node 22', content: 'rerun it, or pin node 20', scope: 'project' })
  await memory.remember({ name: 'esm-only', description: 'jonathan writes esm only', content: 'no commonjs, ever', scope: 'global' })

  const memories = await memory.list()
  assert.deepEqual(memories.map((m) => [m.name, m.scope]), [['esm-only', 'global'], ['flaky-auth-test', 'project']])

  const recalled = await memory.recall('flaky-auth-test')
  assert.equal(recalled.content, 'rerun it, or pin node 20')
  assert.equal(recalled.scope, 'project')

  await assert.rejects(memory.recall('nope'), /known memories: esm-only, flaky-auth-test/)
  delete process.env.PICO_HOME
})

test('remember overwrites same-name memory and validates scope', async () => {
  const root = await fixture()
  const memory = createMemory(root)
  await memory.remember({ name: 'pkg', description: 'old', content: 'yarn' })
  await memory.remember({ name: 'pkg', description: 'uses pnpm', content: 'pnpm, not yarn' })
  const memories = await memory.list()
  assert.equal(memories.length, 1)
  assert.equal((await memory.recall('pkg')).content, 'pnpm, not yarn')
  await assert.rejects(memory.remember({ name: 'x', description: 'd', content: 'c', scope: 'universe' }), /scope must be/)
  delete process.env.PICO_HOME
})

test('forget removes the memory file across scopes', async () => {
  const root = await fixture()
  const memory = createMemory(root)
  await memory.remember({ name: 'keep-me', description: 'stays', content: 'x', scope: 'project' })
  await memory.remember({ name: 'drop-me', description: 'goes', content: 'y', scope: 'global' })

  const gone = await memory.forget('drop-me')
  assert.deepEqual(gone, { name: 'drop-me', scope: 'global' })
  assert.deepEqual((await memory.list()).map((m) => m.name), ['keep-me'])
  await assert.rejects(memory.forget('drop-me'), /no memory named/)
  delete process.env.PICO_HOME
})

test('memories can be suppressed with an underscore filename', async () => {
  const root = await fixture()
  const memory = createMemory(root)
  await memory.remember({ name: 'replace-me', description: 'original', content: 'old value' })
  const original = (await memory.list())[0]

  const suppressed = await memory.setDisabled(original, true)
  assert.equal(suppressed.disabled, true)
  assert.match(suppressed.file, /_replace-me\.md$/)
  await access(suppressed.file)
  assert.equal(memoryIndex(await memory.list(), root).includes('replace-me'), false)
  await assert.rejects(memory.recall('replace-me'), /known memories: none/)

  await memory.remember({ name: 'replace-me', description: 'replacement', content: 'new value' })
  const variants = await memory.list()
  assert.equal(variants.length, 2)
  assert.deepEqual(variants.map((m) => m.disabled), [false, true])
  assert.equal((await memory.recall('replace-me')).content, 'new value')
  await assert.rejects(memory.setDisabled(suppressed, false), /replace-me\.md already exists/)
  delete process.env.PICO_HOME
})

test('memoryIndex renders hooks, and says so when empty', async () => {
  const root = await fixture()
  assert.match(memoryIndex([], root), /no saved memories yet/)
  assert.match(memoryIndex([], root), /without searching the filesystem/)
  const index = memoryIndex(
    [{ name: 'flaky-auth-test', scope: 'project', description: 'auth test fails on node 22' }],
    root,
  )
  assert.match(index, /- flaky-auth-test \(project\): auth test fails on node 22/)
  assert.match(index, /recall tool/)
  delete process.env.PICO_HOME
})

test('slugify normalizes names and rejects empty', () => {
  assert.equal(slugify('  What John Said (auth) '), 'what-john-said-auth')
  assert.throws(() => slugify('!!!'), /must contain/)
})
