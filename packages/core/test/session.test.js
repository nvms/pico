import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendSessionEvent, createEphemeralSession, createSession, forkSession, loadSession, listSessions, openSession, deleteSession, deleteProjectData, onSessionWriteError } from '../src/session.js'
import { makeEvent, makeHeader } from '../src/events.js'
import { agentScratchDir, sessionsDir } from '../src/paths.js'

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

test('listSessions returns immediately for a project without a sessions directory', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))

  await assert.rejects(access(sessionsDir(root)))
  assert.deepEqual(await listSessions({ scope: 'project', root }), [])
  await access(sessionsDir(root))
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
  b.append(makeEvent('message', { message: { role: 'assistant', content: 'first response' } }))
  b.append(makeEvent('message', { message: { role: 'user', content: 'second turn' } }))
  b.append(makeEvent('message', { message: { role: 'assistant', content: 'second response' } }))
  b.append(makeEvent('message', { message: { role: 'tool', content: 'hidden tool output' } }))
  await b.flush()

  const projectScoped = await listSessions({ scope: 'project', root: rootA })
  assert.equal(projectScoped.length, 1)
  assert.equal(projectScoped[0].title, 'session in project a')
  assert.equal(projectScoped[0].turns, 1)

  const everywhere = await listSessions({ scope: 'everywhere', root: rootA })
  assert.equal(everywhere.length, 2)
  const projectB = everywhere.find((s) => s.header.root === rootB)
  assert.equal(projectB.turns, 2)
  assert.equal(projectB.previewMessageCount, 4)
  assert.deepEqual(projectB.preview, [
    { role: 'user', text: 'session in project b' },
    { role: 'assistant', text: 'first response' },
    { role: 'user', text: 'second turn' },
    { role: 'assistant', text: 'second response' },
  ])

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

  await writeFile(`${session.file}.dirty`, '')
  await writeFile(session.file, `${await readFile(session.file, 'utf-8')}${JSON.stringify(makeEvent('title', { text: 'BAR' }))}\n`)
  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'BAR')
  delete process.env.PICO_HOME
})

test('a deletion tombstone removes a stale index entry after a crash', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('title', { text: 'deleted during crash' }))
  await session.flush()
  await writeFile(`${session.file}.deleted`, '')
  await rm(session.file)

  assert.deepEqual(await listSessions({ scope: 'project', root }), [])
  const indexed = JSON.parse(await readFile(join(dirname(session.file), 'index.json'), 'utf-8'))
  assert.deepEqual(indexed.sessions, [])
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
  const markers = async () => (await readdir(dir)).filter((name) => name.endsWith('.jsonl.dirty'))
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

test('a rebuild during a pending window is not replayed on flush', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'turn one' } }))
  await session.flush()
  await listSessions({ scope: 'project', root })

  // the marker makes this read rebuild from the file, absorbing the event the
  // pending batch is still holding
  session.append(makeEvent('message', { message: { role: 'user', content: 'turn two' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await listSessions({ scope: 'project', root }))[0].turns, 2)

  await session.flush()
  assert.equal((await listSessions({ scope: 'project', root }))[0].turns, 2)
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
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.jsonl.dirty')).length, 1)

  assert.equal((await listSessions({ scope: 'project', root }))[0].title, 'never flushed')
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.jsonl.dirty')).length, 0)
  await session.flush()
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.jsonl.dirty')), [])
  delete process.env.PICO_HOME
})

test('a rebuild keeps the active marker until its pending update is flushed', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'turn one' } }))
  await session.flush()

  session.append(makeEvent('message', { message: { role: 'user', content: 'turn two' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await listSessions({ scope: 'project', root }))[0].turns, 2)

  const dir = dirname(session.file)
  const markers = async () => (await readdir(dir)).filter((name) => name.endsWith('.jsonl.dirty'))
  assert.equal((await markers()).length, 0)
  await session.flush()
  assert.deepEqual(await markers(), [])
})

test('session indexing handles UTF-8 content', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: '👋 café' } }))
  await session.flush()
  session.append(makeEvent('message', { message: { role: 'user', content: '第二回' } }))
  await session.flush()
  assert.equal((await listSessions({ scope: 'project', root }))[0].turns, 2)
})

test('deleteSession waits for queued appends before removing the file', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'queued' } }))
  await deleteSession(session.file)
  await assert.rejects(() => session.append(makeEvent('message', { message: { role: 'user', content: 'too late' } })), /deleted/)
  await assert.rejects(access(session.file))
  assert.deepEqual(await listSessions({ scope: 'project', root }), [])
})

test('an append after a truncated line remains independently indexable', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createSession({ cwd: root, root })
  session.append(makeEvent('message', { message: { role: 'user', content: 'first' } }))
  await session.flush()
  await writeFile(session.file, `${await readFile(session.file, 'utf-8')}{"truncated":`)

  session.append(makeEvent('message', { message: { role: 'user', content: 'second' } }))
  await session.flush()
  assert.equal((await listSessions({ scope: 'project', root }))[0].turns, 2)
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
  await assert.rejects(() => session.flush(), { code: 'EISDIR' })
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

test('a failed header write remains visible after a later successful append', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const dir = join(root, 'missing')
  const header = makeHeader({ cwd: root, root })
  const file = join(dir, `${header.id}.jsonl`)
  const session = openSession({ file, header })

  await appendSessionEvent(file, header)
  await mkdir(dir, { recursive: true })
  await writeFile(file, '')
  session.append(makeEvent('title', { text: 'headerless' }))
  await assert.rejects(() => session.flush())
  await assert.rejects(() => loadSession(session.file), /not a pico session file/)
})

test('an ephemeral session writes nothing to disk and forks stay ephemeral', async () => {
  await isolatedHome()
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  const session = createEphemeralSession({ cwd: root, root })
  const events = [makeEvent('message', { message: { role: 'user', content: 'gone soon' } })]
  for (const event of events) session.append(event)
  await session.flush()
  assert.equal(session.file, null)
  assert.equal(session.ephemeral, true)
  assert.equal(session.header.root, root)
  await assert.rejects(access(sessionsDir(root)))
  assert.deepEqual(await listSessions({ scope: 'project', root }), [])

  const fork = await forkSession({ source: session, cwd: root, root, events, label: 'still temporary' })
  assert.equal(fork.session.ephemeral, true)
  assert.equal(fork.session.header.forkedFrom, session.id)
  assert.deepEqual(await listSessions({ scope: 'project', root }), [])
  delete process.env.PICO_HOME
})
