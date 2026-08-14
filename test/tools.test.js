import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolset } from '../src/core/tools/index.js'
import { createContextTracker } from '../src/core/context.js'
import { createShellManager } from '../src/core/shells.js'
import { createBash } from '../src/core/tools/bash.js'
import { createRecorder, recorded } from '../src/core/tools/recorder.js'
import { createEdit } from '../src/core/tools/edit.js'
import { reapplyEdits, revertEdits } from '../src/core/rewind.js'

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'pico-tools-'))
  await writeFile(join(cwd, 'hello.js'), 'const a = 1\nconst b = 2\nconsole.log(a + b)\n')
  await mkdir(join(cwd, 'sub'))
  await writeFile(join(cwd, 'sub', 'nested.js'), 'export const x = 40 + 2\n')
  const tracker = createContextTracker({ stopDir: cwd, loaded: new Set() })
  const { tools, recorder } = createToolset({ cwd, tracker })
  const rawByName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, {
    ...tool,
    execute: (args) => tool.execute({ description: `test ${tool.name}`, ...args }),
  }]))
  return { cwd, byName, rawByName, recorder }
}

test('file and shell tools require purpose descriptions', async () => {
  const { byName } = await fixture()
  for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
    assert.equal(byName[name].schema.description.optional, undefined)
    assert.match(byName[name].schema.description.description, /purpose|why/)
  }
})

test('described tools reject missing and blank descriptions at runtime', async () => {
  const { rawByName } = await fixture()
  await assert.rejects(rawByName.read.execute({ path: 'hello.js' }), /description is required/)
  await assert.rejects(rawByName.read.execute({ path: 'hello.js', description: '   ' }), /description is required/)
})

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
  assert.equal(entry.revert.version, 2)
  assert.deepEqual(entry.revert.splices, [{ start: 0, oldText: 'const a = 1', newText: 'const a = 10' }])
  assert.equal(typeof entry.revert.before.hash, 'string')
  assert.equal(typeof entry.revert.after.hash, 'string')
  assert.ok(JSON.stringify(entry.revert).length < 500)
})

test('replaceAll compact metadata rewinds every replacement', async () => {
  const { cwd, byName, recorder } = await fixture()
  const file = join(cwd, 'repeated.txt')
  await writeFile(file, 'one x two x three')
  await byName.edit.execute({ path: 'repeated.txt', oldText: 'x', newText: 'longer', replaceAll: true })
  const edit = { callId: 'replace-all', revert: recorder.entries[0].revert }

  assert.equal(await readFile(file, 'utf-8'), 'one longer two longer three')
  assert.deepEqual((await revertEdits([edit])).reverted, ['replace-all'])
  assert.equal(await readFile(file, 'utf-8'), 'one x two x three')
  assert.deepEqual((await reapplyEdits([edit])).reapplied, ['replace-all'])
  assert.equal(await readFile(file, 'utf-8'), 'one longer two longer three')
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

test('write does not treat unreadable files as missing', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const { cwd, byName } = await fixture()
  const file = join(cwd, 'unreadable.js')
  await writeFile(file, 'protected\n')
  await chmod(file, 0o000)
  try {
    await assert.rejects(byName.write.execute({ path: 'unreadable.js', content: 'replacement\n' }), /EACCES/)
  } finally {
    await chmod(file, 0o600)
  }
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
  assert.equal(recorder.entries[0].titleLang, 'bash')
})

test('bash records only its last ten output lines with their original positions', async () => {
  const { byName, recorder } = await fixture()
  await byName.bash.execute({
    command: `node -e "for (let i = 1; i <= 20; i++) console.log('line ' + i)"`,
    description: 'generate a bounded output preview',
  })

  assert.equal(recorder.entries[0].fullOutput.split('\n').length, 10)
  assert.match(recorder.entries[0].fullOutput, /^line 11\n/)
  assert.match(recorder.entries[0].fullOutput, /line 20$/)
  assert.equal(recorder.entries[0].outputLineStart, 11)
  assert.equal(recorder.entries[0].outputLineCount, 20)
})

test('bash carries active ANSI styles into its retained output window', async () => {
  const { byName, recorder } = await fixture()
  await byName.bash.execute({
    command: `node -e "process.stdout.write('\\x1b[31m'); for (let i = 1; i <= 12; i++) console.log('red ' + i); process.stdout.write('\\x1b[0m')"`,
    description: 'generate colored output across the preview boundary',
  })

  assert.match(recorder.entries[0].fullOutput, /^\x1b\[0;38;5;1mred 3\n/)
  assert.match(recorder.entries[0].fullOutput, /\x1b\[0;38;5;1mred 12$/)
  assert.equal(recorder.entries[0].outputLineStart, 3)
  assert.equal(recorder.entries[0].outputLineCount, 12)
})

test('aborting bash terminates a foreground command and its children', async () => {
  const controller = new AbortController()
  const recorder = createRecorder()
  const bash = createBash({ cwd: process.cwd(), recorder, signal: controller.signal })
  const startedAt = Date.now()
  const running = bash.execute({ command: `node -e "setTimeout(() => {}, 10000)"` })

  setTimeout(() => controller.abort(), 20)
  const result = await running

  assert.ok(Date.now() - startedAt < 2000)
  assert.notEqual(result.exitCode, 0)
})

test('background bash records its command and description separately', async () => {
  const shells = createShellManager()
  const recorder = createRecorder()
  recorder.begin('bash', {})
  const bash = createBash({ cwd: process.cwd(), recorder, shells })

  const result = await bash.execute({ command: 'sleep 1', background: true, description: 'slow number counter' })
  recorder.done()

  assert.equal(recorder.entries[0].title, 'sleep 1')
  assert.equal(recorder.entries[0].titleLang, 'bash')
  assert.equal(recorder.entries[0].description, 'slow number counter')
  assert.match(result.note, /will notify you when it exits/)
  assert.match(result.note, /end your turn and wait instead of polling/)
  shells.kill(result.shellId)
})

test('bash automatically backgrounds a long-running foreground command', async () => {
  const shells = createShellManager()
  const recorder = createRecorder()
  recorder.begin('bash', {})
  const bash = createBash({ cwd: process.cwd(), recorder, shells, autoBackgroundMs: 20 })

  const result = await bash.execute({ command: 'sleep 1; printf done' })

  assert.equal(result.status, 'running')
  assert.match(result.note, /automatically backgrounded/)
  assert.equal(shells.list().length, 1)
  assert.equal(shells.list()[0].id, result.shellId)
  shells.kill(result.shellId)
})

test('bash receives additional environment variables', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pico-tools-'))
  const tracker = createContextTracker({ stopDir: cwd, loaded: new Set() })
  const { tools } = createToolset({ cwd, tracker, env: { PICO_SCRATCHPAD: '/scratch/example' } })
  const bash = tools.find((tool) => tool.name === 'bash')

  const result = await bash.execute({ command: "printf '%s' \"$PICO_SCRATCHPAD\"", description: 'check an injected environment variable' })

  assert.equal(result.stdout, '/scratch/example')
})

test('shell_output tells the model not to reread an exited shell', async () => {
  const shells = { output: () => ({ status: 'exited', exitCode: 0, output: 'done', totalLines: 1 }) }
  const { tools } = createToolset({ cwd: process.cwd(), shells, allowNames: ['shell_output'] })
  const shellOutput = tools.find((tool) => tool.name === 'shell_output')

  const result = await shellOutput.execute({ id: '1' })

  assert.equal(result.note, 'This shell has exited and its output is complete. Do not call shell_output again for this shell.')
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

test('grep reports a missing pattern clearly', async () => {
  const { byName } = await fixture()
  await assert.rejects(byName.grep.execute({ path: 'src' }), /grep pattern is required/)
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

test('a fuzzy edit rewrites only the matched span', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-edit-'))
  const file = join(dir, 'doc.md')
  const before = 'Title — an em dash\ntrailing spaces here   \n“smart quotes here”\ntail\n'
  await writeFile(file, before)

  const recorder = createRecorder()
  const edit = createEdit({ cwd: dir, recorder, tracker: { check: () => [] } })
  // straight quotes only match after normalization
  const result = await recorded(recorder, 'edit', edit.execute)({ path: 'doc.md', oldText: '"smart quotes here"', newText: 'PLAIN' })

  assert.equal(await readFile(file, 'utf-8'), 'Title — an em dash\ntrailing spaces here   \nPLAIN\ntail\n')
  assert.equal(result.additions, 1)
  assert.equal(result.deletions, 1)
})

test('a fuzzy edit tolerating trailing whitespace keeps the rest of the line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-edit-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'keep me   \nreplace me   \nkeep me too   \n')

  const recorder = createRecorder()
  const edit = createEdit({ cwd: dir, recorder, tracker: { check: () => [] } })
  await recorded(recorder, 'edit', edit.execute)({ path: 'a.txt', oldText: 'replace me\nkeep me too', newText: 'done\nkeep me too' })

  assert.equal(await readFile(file, 'utf-8'), 'keep me   \ndone\nkeep me too   \n')
})

test('a fuzzy edit does not ignore a missing blank line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-edit-'))
  const file = join(dir, 'blank-line.txt')
  const before = 'function a() {}   \n\nfunction b() {}\n'
  await writeFile(file, before)

  const recorder = createRecorder()
  const edit = createEdit({ cwd: dir, recorder, tracker: { check: () => [] } })
  await assert.rejects(
    edit.execute({ path: 'blank-line.txt', oldText: 'function a() {}\nfunction b() {}', newText: 'function merged() {}' }),
    /not found/,
  )

  assert.equal(await readFile(file, 'utf-8'), before)
})

test('edit still reports missing and ambiguous strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-edit-'))
  await writeFile(join(dir, 'b.txt'), 'alpha\nalpha\n')
  const recorder = createRecorder()
  const edit = createEdit({ cwd: dir, recorder, tracker: { check: () => [] } })

  await assert.rejects(edit.execute({ path: 'b.txt', oldText: 'alpha', newText: 'x' }), /appears multiple times/)
  await assert.rejects(edit.execute({ path: 'b.txt', oldText: 'omega', newText: 'x' }), /not found/)
  await assert.rejects(edit.execute({ path: 'b.txt', oldText: '   ', newText: 'x' }), /not found/)
})
