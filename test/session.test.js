import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSession, forkSession, loadSession, listSessions, deleteSession, deleteProjectData, onSessionWriteError } from '../src/core/session.js'
import { makeEvent } from '../src/core/events.js'
import { agentScratchDir } from '../src/core/paths.js'

async function isolatedHome() {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
}

test('session round trip: create, append, load', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'first prompt about signals' } }))
  session.append(makeEvent('message', { message: { role: 'assistant', content: 'sure' } }))
  await session.flush()

  const { header, events } = await loadSession(session.file)
  assert.equal(header.id, session.id)
  assert.equal(header.root, root)
  assert.equal(events.length, 2)
  assert.equal(events[0].data.message.content, 'first prompt about signals')
  delete process.env.PICO_HOME
})

test('forkSession copies the current event log into an independently named session', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const source = createSession({ cwd: root, root })
  const events = [
    makeEvent('message', { message: { role: 'user', content: 'source prompt' } }),
    makeEvent('message', { message: { role: 'assistant', content: 'source answer' } }),
  ]
  for (const event of events) source.append(event)

  const fork = await forkSession({ source, cwd: root, root, events, label: 'alternate' })
  const loaded = await loadSession(fork.session.file)
  assert.notEqual(fork.session.id, source.id)
  assert.equal(loaded.header.forkedFrom, source.id)
  assert.deepEqual(loaded.events.slice(0, -1), events)
  assert.deepEqual(loaded.events.at(-1).data, { text: 'alternate' })

  source.append(makeEvent('message', { message: { role: 'user', content: 'source continues' } }))
  await source.flush()
  assert.equal((await loadSession(fork.session.file)).events.length, 3)
  delete process.env.PICO_HOME
})

test('listSessions surfaces title, turns, scopes', async () => {
  await isolatedHome()
  const rootA = await mkdtemp(join(tmpdir(), 'pico-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'pico-b-'))

  const a = createSession({ cwd: rootA, root: rootA })
  a.append(makeEvent('message', { message: { role: 'user', content: 'session in project a' } }))
  await a.flush()

  const b = createSession({ cwd: rootB, root: rootB })
  b.append(makeEvent('message', { message: { role: 'user', content: 'session in project b' } }))
  b.append(makeEvent('message', { message: { role: 'user', content: 'second turn' } }))
  await b.flush()

  const projectScoped = await listSessions({ scope: 'project', root: rootA })
  assert.equal(projectScoped.length, 1)
  assert.equal(projectScoped[0].title, 'session in project a')
  assert.equal(projectScoped[0].turns, 1)

  const everywhere = await listSessions({ scope: 'everywhere', root: rootA })
  assert.equal(everywhere.length, 2)
  assert.equal(everywhere.find((s) => s.header.root === rootB).turns, 2)

  const empty = createSession({ cwd: rootA, root: rootA })
  await empty.flush()
  const stillOne = await listSessions({ scope: 'project', root: rootA })
  assert.equal(stillOne.length, 1)

  b.append(makeEvent('title', { text: 'auth refactor' }))
  await b.flush()
  const renamed = await listSessions({ scope: 'project', root: rootB })
  assert.equal(renamed[0].title, 'auth refactor')

  b.append(makeEvent('title', { text: null }))
  await b.flush()
  const reset = await listSessions({ scope: 'project', root: rootB })
  assert.equal(reset[0].title, 'session in project b')
  delete process.env.PICO_HOME
})

test('listSessions rebuilds a missing index for existing projects and reuses it', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'indexed prompt' } }))
  await session.flush()
  const index = join(dirname(session.file), 'index.json')
  await rm(index, { force: true })

  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'indexed prompt')
  assert.equal(JSON.parse(await readFile(index, 'utf-8')).sessions.length, 1)
  await writeFile(session.file, 'this would fail if the session were reparsed')
  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'indexed prompt')
  delete process.env.PICO_HOME
})

test('listSessions rebuilds an index left dirty by an interrupted update', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'foo' } }))
  await session.flush()
  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'foo')

  await writeFile(join(dirname(session.file), `.index-dirty-${session.id}`), '')
  await writeFile(session.file, `${await readFile(session.file, 'utf-8')}${JSON.stringify(makeEvent('title', { text: 'BAR' }))}\n`)
  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'BAR')
  delete process.env.PICO_HOME
})

test('deleteSession removes its scratchpads', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  await session.flush()
  const scratchpad = agentScratchDir(root, session.id, '1')
  await mkdir(scratchpad, { recursive: true })

  await deleteSession(session.file)

  await assert.rejects(access(session.file))
  await assert.rejects(access(scratchpad))
})

test('deleteProjectData removes every session for that root and nothing else', async () => {
  await isolatedHome()
  const rootA = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const rootB = await mkdtemp(join(tmpdir(), 'pico-proj-'))

  const a = createSession({ cwd: rootA, root: rootA })
  a.append(makeEvent('message', { message: { role: 'user', content: 'keep me' } }))
  await a.flush()
  const b = createSession({ cwd: rootB, root: rootB })
  b.append(makeEvent('message', { message: { role: 'user', content: 'delete me' } }))
  await b.flush()

  await deleteProjectData(rootB)
  const everywhere = await listSessions({ scope: 'everywhere', root: rootA })
  assert.equal(everywhere.length, 1)
  assert.equal(everywhere[0].header.root, rootA)

  await deleteProjectData(rootB)
  delete process.env.PICO_HOME
})

test('a burst of events shares one dirty window and one index write', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'first turn' } }))
  await session.flush()
  const dir = dirname(session.file)
  await listSessions({ scope: 'project', root })
  const markers = async () => (await readdir(dir)).filter((name) => name.startsWith('.index-dirty-'))
  assert.deepEqual(await markers(), [])

  for (let i = 0; i < 20; i++) {
    session.append(makeEvent('tool_meta', { callId: String(i), name: 'read', title: `file-${i}` }))
  }
  session.append(makeEvent('message', { message: { role: 'user', content: 'second turn' } }))
  assert.equal((await markers()).length, 1, '21 appends should open a single dirty window')

  await session.flush()
  assert.deepEqual(await markers(), [])
  const listed = await listSessions({ scope: 'project', root })
  assert.equal(listed[0].title, 'first turn')
  assert.equal(listed[0].turns, 2)
  delete process.env.PICO_HOME
})

test('an unflushed batch leaves a marker so the next read rebuilds', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'flushed' } }))
  await session.flush()
  await listSessions({ scope: 'project', root })

  session.append(makeEvent('title', { text: 'never flushed' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const dir = dirname(session.file)
  assert.equal((await readdir(dir)).filter((name) => name.startsWith('.index-dirty-')).length, 1)

  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'never flushed')
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.index-dirty-')), [])
  delete process.env.PICO_HOME
})

test('a failed append is reported and does not wedge later appends', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  await session.flush()

  const errors = []
  onSessionWriteError((err) => errors.push(err.code))
  await rm(session.file)
  await mkdir(session.file) // any append now fails with EISDIR

  session.append(makeEvent('message', { message: { role: 'user', content: 'lost' } }))
  await session.flush()
  assert.deepEqual(errors, ['EISDIR'])

  await rm(session.file, { recursive: true })
  await writeFile(session.file, `${JSON.stringify({ ...session.header })}\n`)
  session.append(makeEvent('message', { message: { role: 'user', content: 'written after recovery' } }))
  await session.flush()

  const { events } = await loadSession(session.file)
  assert.equal(events.at(-1).data.message.content, 'written after recovery')
  onSessionWriteError(null)
  delete process.env.PICO_HOME
})

test('a missing sessions directory reports instead of throwing out of append', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  await session.flush()

  const errors = []
  onSessionWriteError((err) => errors.push(err.code))
  await rm(dirname(session.file), { recursive: true, force: true })

  assert.doesNotThrow(() => session.append(makeEvent('message', { message: { role: 'user', content: 'gone' } })))
  await session.flush()
  assert.ok(errors.includes('ENOENT'))
  onSessionWriteError(null)
  delete process.env.PICO_HOME
})
