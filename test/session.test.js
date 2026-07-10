import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, loadSession, listSessions, deleteProjectData } from '../src/core/session.js'
import { makeEvent } from '../src/core/events.js'

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
  delete process.env.PICO_HOME
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
