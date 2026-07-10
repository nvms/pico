import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStartupContext, createContextTracker } from '../src/core/context.js'

async function project() {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-ctx-'))
  await mkdir(join(root, '.git'))
  return root
}

test('CLAUDE.md is a per-directory fallback, AGENTS.md wins when both exist', async () => {
  const root = await project()
  await writeFile(join(root, 'AGENTS.md'), 'root agents rules')
  await writeFile(join(root, 'CLAUDE.md'), 'root claude rules')
  await mkdir(join(root, 'lib'))
  await writeFile(join(root, 'lib', 'CLAUDE.md'), 'lib claude rules')

  const { files } = loadStartupContext(join(root, 'lib'))
  assert.deepEqual(files.map((f) => f.content), ['root agents rules', 'lib claude rules'])
  assert.ok(files[1].path.endsWith('CLAUDE.md'))
  delete process.env.PICO_HOME
})

test('global context is ~/.pico/AGENTS.md only, never a CLAUDE.md', async () => {
  const root = await project()
  await writeFile(join(process.env.PICO_HOME, 'AGENTS.md'), 'global rules')
  await writeFile(join(process.env.PICO_HOME, 'CLAUDE.md'), 'should never load')

  const { files } = loadStartupContext(root)
  assert.deepEqual(files.map((f) => f.content), ['global rules'])
  delete process.env.PICO_HOME
})

test('tracker lazily loads CLAUDE.md fallbacks and never double-loads a dir', async () => {
  const root = await project()
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'CLAUDE.md'), 'sub claude rules')

  const tracker = createContextTracker({ stopDir: root, loaded: new Set() })
  const first = tracker.check(join(root, 'sub', 'file.js'))
  assert.deepEqual(first.map((f) => f.content), ['sub claude rules'])
  assert.deepEqual(tracker.check(join(root, 'sub', 'other.js')), [])
  delete process.env.PICO_HOME
})
