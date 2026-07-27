import { writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseLines } from './events.js'

const INDEX_VERSION = 1
const INDEX_FILE = 'index.json'
const DIRTY_PREFIX = '.index-dirty-'

// a session appends dozens of events per turn, and almost none of them change
// anything the index stores. events are collected per session and applied in
// one read-modify-write per directory; the dirty marker written before the
// first one covers the whole window, so an interrupted batch still rebuilds
const FLUSH_DELAY_MS = 1000

const dirtySessions = new Map()
let flushTimer = null
let indexWrites = Promise.resolve()

function metadata(file, header, events, at) {
  let title = null
  let customTitle
  let color = null
  let turns = 0
  for (const event of events) {
    if (event.type === 'message' && event.data?.message?.role === 'user') {
      turns++
      if (!title) {
        const content = event.data.message.content
        const text = typeof content === 'string' ? content : content?.find((part) => part.type === 'text')?.text
        title = text?.trim().slice(0, 200) || null
      }
    }
    if (event.type === 'title') customTitle = event.data.text
    if (event.type === 'color') color = event.data.value
  }
  return { file, header, title: customTitle || title || 'Untitled session', automaticTitle: title, customTitle, color, turns, at }
}

async function metadataFromFile(file) {
  const [text, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)])
  const [header, ...events] = parseLines(text)
  if (!header || header.type !== 'session') throw new Error('invalid session')
  return metadata(file, header, events, info.mtimeMs)
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
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, sessions }) + '\n')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function dirtyPath(file) {
  return join(dirname(file), `${DIRTY_PREFIX}${basename(file, '.jsonl')}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

async function rebuildIndex(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = names.filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
  const sessions = (await Promise.all(files.map((file) => metadataFromFile(file).catch(() => null))))
    .filter(Boolean)
  await writeIndex(dir, sessions)
  await Promise.all(names.filter((name) => name.startsWith(DIRTY_PREFIX)).map((name) => rm(join(dir, name), { force: true })))
  return sessions
}

export async function indexedSessions(dir) {
  try {
    const names = await readdir(dir)
    if (names.some((name) => name.startsWith(DIRTY_PREFIX))) return rebuildIndex(dir)
    return await readIndex(dir)
  } catch {
    return rebuildIndex(dir)
  }
}

function applyEvent(meta, event, at) {
  const next = { ...meta, at }
  if (event.type === 'message' && event.data?.message?.role === 'user') {
    next.turns++
    if (!next.automaticTitle) {
      const content = event.data.message.content
      const text = typeof content === 'string' ? content : content?.find((part) => part.type === 'text')?.text
      next.automaticTitle = text?.trim().slice(0, 200) || null
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

function dirtySession(file, onError = () => {}) {
  let entry = dirtySessions.get(file)
  if (!entry) {
    // a marker we cannot write only costs crash recovery for this window;
    // throwing here would take the whole session down with it
    let marker = dirtyPath(file)
    try {
      writeFileSync(marker, '')
    } catch (err) {
      onError(err)
      marker = null
    }
    entry = { file, header: null, events: [], marker }
    dirtySessions.set(file, entry)
  }
  return entry
}

export function markSessionIndexDirty(file, onError) {
  dirtySession(file, onError)
}

export function recordSessionEvent(file, header, event) {
  const entry = dirtySession(file)
  if (header && !entry.header) entry.header = header
  entry.events.push(event)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionIndex()
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

async function applyBatch(dir, entries) {
  let sessions
  try {
    sessions = await readIndex(dir)
  } catch {
    // no usable index: the markers stay behind so the next read rebuilds
    return
  }
  const applied = []
  const at = Date.now()
  for (const entry of entries) {
    const id = entry.header?.id || basename(entry.file, '.jsonl')
    const index = sessions.findIndex((session) => session.header.id === id)
    if (index < 0) {
      // without a header there is nothing to seed a new row from; leaving the
      // marker in place lets the next read rebuild the session in
      if (!entry.header) continue
      sessions.push(metadata(entry.file, entry.header, entry.events.filter((event) => event.type !== 'session'), at))
    } else {
      sessions[index] = entry.events.reduce((meta, event) => applyEvent(meta, event, at), sessions[index])
    }
    applied.push(entry)
  }
  await writeIndex(dir, sessions)
  await Promise.all(applied.filter((entry) => entry.marker).map((entry) => rm(entry.marker, { force: true })))
}

export function flushSessionIndex() {
  if (dirtySessions.size === 0) return indexWrites
  const batch = [...dirtySessions.values()]
  dirtySessions.clear()
  clearTimeout(flushTimer)
  flushTimer = null
  const byDir = Map.groupBy(batch, (entry) => dirname(entry.file))
  indexWrites = indexWrites
    .then(() => Promise.all([...byDir].map(([dir, entries]) => applyBatch(dir, entries))))
    .catch(() => {})
  return indexWrites
}

export function removeFromSessionIndex(file) {
  const pending = dirtySessions.get(file)
  dirtySessions.delete(file)
  const dir = dirname(file)
  const id = basename(file, '.jsonl')
  indexWrites = indexWrites.then(async () => {
    if (pending?.marker) await rm(pending.marker, { force: true })
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    await writeIndex(dir, sessions.filter((session) => session.header.id !== id))
  }).catch(() => {})
  return indexWrites
}
