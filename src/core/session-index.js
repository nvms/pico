import { writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseLines } from './events.js'
import { withIndexLock, withSessionLock } from './session-lock.js'

const INDEX_VERSION = 4
const INDEX_FILE = 'index.json'
const DIRTY_SUFFIX = '.dirty'
const DELETED_SUFFIX = '.jsonl.deleted'
const FLUSH_DELAY_MS = 1000

const dirtyFiles = new Set()
let flushTimer = null
let indexWrites = Promise.resolve()

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function applyEvent(meta, event) {
  const next = { ...meta }
  if (event.type === 'message' && ['user', 'assistant'].includes(event.data?.message?.role)) {
    const { role, content } = event.data.message
    const text = messageText(content).trim()
    if (text) {
      next.previewMessageCount++
      next.preview = [...next.preview, { role, text }]
      const userIndexes = next.preview.flatMap((message, index) => message.role === 'user' ? [index] : [])
      if (userIndexes.length > 2) next.preview = next.preview.slice(userIndexes.at(-2))
    }
    if (role !== 'user') return next
    next.turns++
    if (!next.automaticTitle) {
      next.automaticTitle = text.slice(0, 200) || null
      if (!next.customTitle) next.title = next.automaticTitle || next.title
    }
  }
  if (event.type === 'title') {
    next.customTitle = event.data.text
    next.title = event.data.text || next.automaticTitle || 'Untitled session'
  }
  if (event.type === 'color') next.color = event.data.value
  return next
}

async function metadataFromFile(file) {
  const text = await readFile(file, 'utf-8')
  const [header, ...events] = parseLines(text)
  if (!header || header.type !== 'session') throw new Error('invalid session')
  const { mtimeMs } = await stat(file)
  return events.reduce(applyEvent, {
    file,
    header,
    title: 'Untitled session',
    automaticTitle: null,
    customTitle: undefined,
    color: null,
    turns: 0,
    preview: [],
    previewMessageCount: 0,
    at: mtimeMs,
  })
}

function indexPath(dir) {
  return join(dir, INDEX_FILE)
}

async function readIndex(dir) {
  const parsed = JSON.parse(await readFile(indexPath(dir), 'utf-8'))
  if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.sessions)) throw new Error('invalid session index')
  return parsed.sessions
}

async function writeIndex(dir, sessions) {
  await mkdir(dir, { recursive: true })
  const file = indexPath(dir)
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, sessions }) + '\n')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function dirtyPath(file) {
  return `${file}${DIRTY_SUFFIX}`
}

function fileFromDirtyName(dir, name) {
  return join(dir, name.slice(0, -DIRTY_SUFFIX.length))
}

function enqueueIndexWrite(task) {
  const result = indexWrites.then(task)
  indexWrites = result.catch(() => {})
  return result
}

async function rebuildIndex(dir, names) {
  if (!names) {
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
  }
  const files = names.filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
  const sessions = (await Promise.all(files.map((file) => metadataFromFile(file).catch(() => null)))).filter(Boolean)
  await writeIndex(dir, sessions)
  return sessions
}

async function refreshFiles(dir, sessions, files) {
  for (const file of files) {
    try {
      const row = await withSessionLock(file, () => metadataFromFile(file))
      const at = sessions.findIndex((session) => session.file === file)
      if (at < 0) sessions.push(row)
      else sessions[at] = row
    } catch (err) {
      if (err.code === 'ENOENT') sessions = sessions.filter((session) => session.file !== file)
      else throw err
    }
  }
  await writeIndex(dir, sessions)
  await Promise.all(files.map((file) => rm(dirtyPath(file), { force: true })))
  return sessions
}

async function currentSessions(dir) {
  const names = await readdir(dir)
  let sessions
  try {
    sessions = await readIndex(dir)
  } catch {
    return rebuildIndex(dir, names)
  }

  const dirty = names.filter((name) => name.endsWith(`.jsonl${DIRTY_SUFFIX}`)).map((name) => fileFromDirtyName(dir, name))
  if (dirty.length > 0) sessions = await refreshFiles(dir, sessions, [...new Set(dirty)])

  const deleted = new Set(names.filter((name) => name.endsWith(DELETED_SUFFIX)).map((name) => join(dir, name.slice(0, -'.deleted'.length))))
  if (deleted.size > 0) {
    const filtered = sessions.filter((session) => !deleted.has(session.file))
    if (filtered.length !== sessions.length) await writeIndex(dir, filtered)
    sessions = filtered
  }
  return sessions
}

export function indexedSessions(dir) {
  return enqueueIndexWrite(() => withIndexLock(dir, () => currentSessions(dir))).catch(async (err) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
}

export function markSessionIndexDirty(file, onError = () => {}) {
  dirtyFiles.add(file)
  try {
    writeFileSync(dirtyPath(file), '')
  } catch (err) {
    onError(err)
  }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionIndex().catch(() => {})
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

export function scheduleSessionIndexUpdate(file) {
  dirtyFiles.add(file)
  scheduleFlush()
}

export function flushSessionIndex() {
  if (dirtyFiles.size === 0) return indexWrites
  const files = [...dirtyFiles]
  dirtyFiles.clear()
  clearTimeout(flushTimer)
  flushTimer = null
  const byDir = Map.groupBy(files, dirname)
  return enqueueIndexWrite(async () => {
    const failed = []
    await Promise.all([...byDir].map(async ([dir, projectFiles]) => {
      try {
        await withIndexLock(dir, async () => {
          let sessions
          try {
            sessions = await readIndex(dir)
          } catch {
            sessions = await rebuildIndex(dir)
          }
          await refreshFiles(dir, sessions, projectFiles)
        })
      } catch (err) {
        failed.push(...projectFiles)
      }
    }))
    if (failed.length > 0) {
      failed.forEach((file) => dirtyFiles.add(file))
      scheduleFlush()
      throw new Error('failed to update session index')
    }
  })
}

export function removeFromSessionIndex(file) {
  dirtyFiles.delete(file)
  const dir = dirname(file)
  return enqueueIndexWrite(() => withIndexLock(dir, async () => {
    await rm(dirtyPath(file), { force: true })
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    await writeIndex(dir, sessions.filter((session) => session.file !== file))
  }))
}
