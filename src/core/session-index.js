import { writeFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseLines } from './events.js'

const INDEX_VERSION = 1
const INDEX_FILE = 'index.json'
const DIRTY_PREFIX = '.index-dirty-'

// a session appends dozens of events per turn and almost none of them change
// anything the index stores, so dirty sessions are collected and settled in one
// read-modify-write per directory. each row records how many bytes of its
// session file it already reflects, which is what makes the update idempotent:
// a concurrent rebuild moves the row past the same events, and the pending
// update then finds nothing new rather than counting them twice
const FLUSH_DELAY_MS = 1000

const dirtySessions = new Map()
let flushTimer = null
let indexWrites = Promise.resolve()

function metadata(file, header, events, { at, bytes }) {
  const base = {
    file,
    header,
    title: 'Untitled session',
    automaticTitle: null,
    customTitle: undefined,
    color: null,
    turns: 0,
    at,
    bytes,
  }
  return events.reduce(applyEvent, base)
}

function applyEvent(meta, event) {
  const next = { ...meta }
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

async function metadataFromFile(file) {
  const [text, info] = await Promise.all([readFile(file, 'utf-8'), stat(file)])
  const [header, ...events] = parseLines(text)
  if (!header || header.type !== 'session') throw new Error('invalid session')
  return metadata(file, header, events, { at: info.mtimeMs, bytes: info.size })
}

async function readRange(file, start, end) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

// only the bytes appended since this row was last updated are parsed, so a
// 30mb session costs the same to keep current as a fresh one
async function advanceRow(row) {
  if (typeof row.bytes !== 'number') return metadataFromFile(row.file)
  const { size } = await stat(row.file)
  if (size < row.bytes) return metadataFromFile(row.file)
  if (size === row.bytes) return { ...row, at: Date.now() }

  const tail = await readRange(row.file, row.bytes, size)
  // stop at the last complete line: a partially written one is re-read next time
  const lastBreak = tail.lastIndexOf(0x0a)
  if (lastBreak === -1) return { ...row, at: Date.now() }
  const complete = tail.subarray(0, lastBreak + 1)
  const events = parseLines(complete.toString('utf-8'))
  return { ...events.reduce(applyEvent, row), at: Date.now(), bytes: row.bytes + complete.length }
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
    entry = { file, marker }
    dirtySessions.set(file, entry)
  }
  return entry
}

export function markSessionIndexDirty(file, onError) {
  dirtySession(file, onError)
}

export function scheduleSessionIndexUpdate(file) {
  dirtySession(file)
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
  for (const entry of entries) {
    try {
      const at = sessions.findIndex((session) => session.file === entry.file)
      if (at < 0) sessions.push(await metadataFromFile(entry.file))
      else sessions[at] = await advanceRow(sessions[at])
      applied.push(entry)
    } catch {
      // leave this one marked so the next read rebuilds it
    }
  }
  if (applied.length === 0) return
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
  indexWrites = indexWrites.then(async () => {
    if (pending?.marker) await rm(pending.marker, { force: true })
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    await writeIndex(dir, sessions.filter((session) => session.file !== file))
  }).catch(() => {})
  return indexWrites
}
