import { access, appendFile, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { picoHome, sessionsDir, ensureDir, projectDir } from './paths.js'
import { flushSessionIndex, indexedSessions, markSessionIndexDirty, removeFromSessionIndex, scheduleSessionIndexUpdate } from './session-index.js'
import { makeEvent, makeHeader, serializeLine, parseLines } from './events.js'

const appendQueues = new Map()
const writeFailures = new Map()
const creationFailures = new Map()
const deletedSessions = new Set()

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

function deletedPath(file) {
  return `${file}.deleted`
}

async function withSessionLock(file, task) {
  const lockTarget = dirname(file)
  const release = await lockfile.lock(lockTarget, {
    lockfilePath: `${file}.lock`,
    realpath: false,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
  })
  try {
    return await task()
  } finally {
    await release()
  }
}

async function repairIncompleteLine(file) {
  let handle
  try {
    handle = await open(file, 'r+')
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    if (last[0] !== 0x0a) await handle.write('\n', size)
  } finally {
    await handle.close()
  }
}

export function appendSessionEvent(file, event) {
  if (deletedSessions.has(file)) return Promise.reject(new Error(`session has been deleted: ${file}`))
  markSessionIndexDirty(file, (err) => reportWriteError(file, err))
  const queued = (appendQueues.get(file) || Promise.resolve()).then(async () => {
    try {
      await withSessionLock(file, async () => {
        if (deletedSessions.has(file)) throw new Error(`session has been deleted: ${file}`)
        try {
          await access(deletedPath(file))
          throw new Error(`session has been deleted: ${file}`)
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
        if (event.type === 'session') {
          await writeFile(file, serializeLine(event), { flag: 'wx' })
        } else {
          await repairIncompleteLine(file)
          await appendFile(file, serializeLine(event))
        }
      })
    } catch (err) {
      writeFailures.set(file, err)
      if (event.type === 'session') creationFailures.set(file, err)
      reportWriteError(file, err)
      scheduleSessionIndexUpdate(file)
      return
    }
    writeFailures.delete(file)
    scheduleSessionIndexUpdate(file)
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
      return appendSessionEvent(file, event)
    },
    async flush() {
      await (appendQueues.get(file) || Promise.resolve())
      const failure = creationFailures.get(file) || writeFailures.get(file)
      if (failure) throw failure
      return flushSessionIndex()
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
  deletedSessions.add(file)
  await (appendQueues.get(file) || Promise.resolve())
  appendQueues.delete(file)
  writeFailures.delete(file)
  creationFailures.delete(file)
  await withSessionLock(file, async () => {
    await writeFile(deletedPath(file), '')
    await rm(file, { force: true })
  })
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
