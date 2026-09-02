import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerRoot, projectDir, sessionsDir, sharedProjectDir } from '../src/paths.js'
import { projectMemoryDir } from '../src/memory.js'

test('a worktree shares its repository project dir but keeps its own sessions', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pico-owner-')))
  const root = join(base, 'repo')
  const run = (args, cwd = root) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  await writeFile(join(root, 'a.txt'), 'a')
  run(['add', 'a.txt'])
  run(['commit', '-qm', 'one'])
  const tree = join(base, 'tree')
  run(['worktree', 'add', '-q', '-b', 'wt/x', tree])
  assert.equal(ownerRoot(root), root)
  assert.equal(ownerRoot(tree), root)
  assert.equal(sharedProjectDir(tree), projectDir(root))
  assert.equal(projectMemoryDir(tree), projectMemoryDir(root))
  assert.notEqual(sessionsDir(tree), sessionsDir(root))
  const plain = join(base, 'plain')
  execFileSync('mkdir', [plain])
  assert.equal(ownerRoot(plain), plain)
})
