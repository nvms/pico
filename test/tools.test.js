import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolset } from '../src/core/tools/index.js'
import { createContextTracker } from '../src/core/context.js'

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'pico-tools-'))
  await writeFile(join(cwd, 'hello.js'), 'const a = 1\nconst b = 2\nconsole.log(a + b)\n')
  await mkdir(join(cwd, 'sub'))
  await writeFile(join(cwd, 'sub', 'nested.js'), 'export const x = 40 + 2\n')
  const tracker = createContextTracker({ stopDir: cwd, loaded: new Set() })
  const { tools, recorder } = createToolset({ cwd, tracker })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  return { cwd, byName, recorder }
}

test('read returns numbered lines and records full output', async () => {
  const { byName, recorder } = await fixture()
  const result = await byName.read.execute({ path: 'hello.js' })
  assert.match(result.content, /^1\tconst a = 1/)
  assert.equal(result.totalLines, 4)
  assert.equal(recorder.entries[0].title, 'hello.js')
  assert.match(recorder.entries[0].fullOutput, /const a = 1/)
})

test('read respects offset and limit', async () => {
  const { byName } = await fixture()
  const result = await byName.read.execute({ path: 'hello.js', offset: 2, limit: 1 })
  assert.equal(result.content, '2\tconst b = 2')
  assert.match(result.note, /showing lines 2-2 of 4/)
})

test('edit replaces unique text and records diff and revert', async () => {
  const { cwd, byName, recorder } = await fixture()
  const result = await byName.edit.execute({ path: 'hello.js', oldText: 'const a = 1', newText: 'const a = 10' })
  assert.equal(result.additions, 1)
  assert.equal(result.deletions, 1)
  assert.match(await readFile(join(cwd, 'hello.js'), 'utf-8'), /const a = 10/)
  const entry = recorder.entries[0]
  assert.ok(entry.diff.hunks.length)
  assert.match(entry.revert.before, /const a = 1\n/)
  assert.match(entry.revert.after, /const a = 10/)
})

test('edit rejects ambiguous text', async () => {
  const { byName } = await fixture()
  await assert.rejects(
    byName.edit.execute({ path: 'hello.js', oldText: 'const', newText: 'let' }),
    /multiple times/,
  )
})

test('edit records error status on missing text', async () => {
  const { byName, recorder } = await fixture()
  await assert.rejects(byName.edit.execute({ path: 'hello.js', oldText: 'nope', newText: 'x' }), /not found/)
  assert.equal(recorder.entries[0].status, 'error')
})

test('write with identical content is a recorded no-op', async () => {
  const { byName, recorder } = await fixture()
  const content = 'const a = 1\nconst b = 2\nconsole.log(a + b)\n'
  const result = await byName.write.execute({ path: 'hello.js', content })
  assert.equal(result.unchanged, true)
  assert.equal(recorder.entries[0].revert, undefined)
  assert.equal(recorder.entries[0].diff, undefined)
})

test('write creates files with parents and diffs overwrites', async () => {
  const { cwd, byName, recorder } = await fixture()
  const created = await byName.write.execute({ path: 'deep/new.js', content: 'hi\n' })
  assert.equal(created.created, true)
  assert.equal(await readFile(join(cwd, 'deep/new.js'), 'utf-8'), 'hi\n')

  const overwritten = await byName.write.execute({ path: 'hello.js', content: 'replaced\n' })
  assert.ok(overwritten.additions >= 1)
  assert.ok(recorder.entries[1].diff)
})

test('bash runs commands and captures exit codes', async () => {
  const { byName, recorder } = await fixture()
  const ok = await byName.bash.execute({ command: 'echo hello && exit 0' })
  assert.equal(ok.exitCode, 0)
  assert.match(ok.stdout, /hello/)
  const bad = await byName.bash.execute({ command: 'exit 3' })
  assert.equal(bad.exitCode, 3)
  assert.equal(recorder.entries[0].title, 'echo hello && exit 0')
})

test('glob finds files and ignores node_modules', async () => {
  const { cwd, byName } = await fixture()
  await mkdir(join(cwd, 'node_modules/junk'), { recursive: true })
  await writeFile(join(cwd, 'node_modules/junk/x.js'), '')
  const result = await byName.glob.execute({ pattern: '**/*.js' })
  assert.deepEqual(result.files.sort(), ['hello.js', 'sub/nested.js'])
})

test('glob and grep see hidden files but never .git', async () => {
  const { cwd, byName } = await fixture()
  await mkdir(join(cwd, '.artifacts'), { recursive: true })
  await mkdir(join(cwd, '.git'), { recursive: true })
  await writeFile(join(cwd, '.artifacts/DECISIONS.md'), 'we chose tabs\n')
  await writeFile(join(cwd, '.prettierrc'), '{ "semi": false }\n')
  await writeFile(join(cwd, '.git/config'), 'we chose tabs\n')

  const found = await byName.glob.execute({ pattern: '**/.*' })
  assert.ok(found.files.includes('.prettierrc'))
  assert.ok(!found.files.some((f) => f.startsWith('.git/')))

  const md = await byName.glob.execute({ pattern: '.artifacts/**' })
  assert.deepEqual(md.files, ['.artifacts/DECISIONS.md'])

  const hits = await byName.grep.execute({ pattern: 'we chose tabs', mode: 'files' })
  assert.deepEqual(hits.results, ['.artifacts/DECISIONS.md'])
})

test('grep content and files modes', async () => {
  const { byName } = await fixture()
  const content = await byName.grep.execute({ pattern: 'const b' })
  assert.equal(content.totalMatches, 1)
  assert.match(content.results[0], /hello\.js:2/)
  const files = await byName.grep.execute({ pattern: 'x = 40', mode: 'files' })
  assert.deepEqual(files.results, ['sub/nested.js'])
})

test('reading under a fresh AGENTS.md surfaces it once', async () => {
  const { cwd, byName } = await fixture()
  await writeFile(join(cwd, 'sub', 'AGENTS.md'), 'always use tabs in here')
  const first = await byName.read.execute({ path: 'sub/nested.js' })
  assert.equal(first.context_from_agents_md.length, 1)
  assert.match(first.context_from_agents_md[0].content, /tabs/)
  const second = await byName.read.execute({ path: 'sub/nested.js' })
  assert.equal(second.context_from_agents_md, undefined)
})
