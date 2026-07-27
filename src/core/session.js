import { appendFile, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { picoHome, sessionsDir, ensureDir, projectDir } from './paths.js'
import { flushSessionIndex, indexedSessions, markSessionIndexDirty, recordSessionEvent, removeFromSessionIndex } from './session-index.js'
import { makeEvent, makeHeader, serializeLine, parseLines } from './events.js'

const appendQueues = new Map()

let onWriteError = () => {}

// appends are chained so they cannot interleave. a rejected link would poison
// every later append on that file, so failures are reported and absorbed here
// instead of propagating: one bad write must not silently end the log
export function onSessionWriteError(handler) {
  onWriteError = handler || (() => {})
}

function reportWriteError(file, err) {
  try {
    onWriteError(err, file)
  } catch {}
}

export function appendSessionEvent(file, event, header) {
  markSessionIndexDirty(file, (err) => reportWriteError(file, err))
  const queued = (appendQueues.get(file) || Promise.resolve()).then(async () => {
    try {
      await appendFile(file, serializeLine(event))
    } catch (err) {
      reportWriteError(file, err)
      return
    }
    recordSessionEvent(file, header, event)
  })
  appendQueues.set(file, queued)
  return queued
}

export function createSession({ cwd, root, forkedFrom }) {
  const header = makeHeader({ cwd, root, forkedFrom })
  const file = join(ensureDir(sessionsDir(root)), `${header.id}.jsonl`)
  const session = openSession({ file, header })
  session.append(header)
  return session
}

export async function forkSession({ source, cwd, root, events, label }) {
  await source?.flush()
  const session = createSession({ cwd, root, forkedFrom: source?.id })
  for (const event of events) session.append(event)
  const title = makeEvent('title', { text: label })
  session.append(title)
  await session.flush()
  return { session, events: [...events, title] }
}

export function openSession({ file, header }) {
  return {
    id: header.id,
    file,
    header,
    append(event) {
      return appendSessionEvent(file, event, header)
    },
    flush() {
      return (appendQueues.get(file) || Promise.resolve()).then(flushSessionIndex)
    },
  }
}

export async function loadSession(file) {
  const events = parseLines(await readFile(file, 'utf-8'))
  const header = events[0]?.type === 'session' ? events.shift() : null
  if (!header) throw new Error(`not a pico session file: ${file}`)
  return { header, events }
}

export async function deleteSession(file) {
  const sessionId = basename(file, '.jsonl')
  const project = dirname(dirname(file))
  await rm(file)
  await removeFromSessionIndex(file)
  await rm(join(project, 'scratchpads', sessionId), { recursive: true, force: true })
}

export function deleteProjectData(root) {
  return rm(projectDir(root), { recursive: true, force: true })
}

export async function listSessions({ scope, root }) {
  let sessions
  if (scope === 'everywhere') {
    const projectsDir = join(picoHome(), 'projects')
    let projects = []
    try {
      projects = await readdir(projectsDir)
    } catch {}
    sessions = (await Promise.all(projects.map((project) => indexedSessions(join(projectsDir, project, 'sessions'))))).flat()
  } else {
    sessions = await indexedSessions(sessionsDir(root))
  }
  return sessions.filter((session) => session.title !== 'Untitled session').sort((a, b) => b.at - a.at)
}
