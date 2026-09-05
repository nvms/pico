import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles } from '../src/files.js'
import { createGlob } from '../src/tools/glob.js'

test('file discovery respects nested ignore rules without ripgrep', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pico-ignore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = process.env.PATH
  process.env.PATH = root
  t.after(() => { if (path === undefined) delete process.env.PATH; else process.env.PATH = path })
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, '.gitignore'), 'secret.txt\n*.log\nAGENTS.md\nCLAUDE.md\n')
  await writeFile(join(root, 'nested', '.gitignore'), '!keep.log\nprivate.txt\n')
  for (const name of ['secret.txt', 'AGENTS.md', 'CLAUDE.md', 'index.js', 'nested/drop.log', 'nested/keep.log', 'nested/private.txt', 'nested/open.js']) {
    await writeFile(join(root, name), '')
  }
  const expected = ['.gitignore', 'index.js', 'nested/.gitignore', 'nested/keep.log', 'nested/open.js']
  assert.deepEqual((await listFiles(root)).sort(), expected)
  const glob = createGlob({ cwd: root, recorder: { extra() {} } })
  assert.deepEqual((await glob.execute({ pattern: '**/*' })).files.sort(), expected)
  assert.deepEqual((await glob.execute({ pattern: '**/*.js' })).files.sort(), ['index.js', 'nested/open.js'])
  assert.deepEqual((await glob.execute({ pattern: '**/*.missing' })).files, [])
})
