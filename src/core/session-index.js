import { writeFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { parseLines } from './events.js'

const INDEX_VERSION = 2
const INDEX_FILE = 'index.json'
const DIRTY_PREFIX = '.index-dirty-'
const FLUSH_DELAY_MS = 1000

const dirtySessions = new Map()
const removedSessions = new Set()
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
  const handle = await open(file, 'r')
  try {
    const buffer = await handle.readFile()
    const lastBreak = buffer.lastIndexOf(0x0a)
    if (lastBreak === -1) throw new Error('invalid session')
    const complete = buffer.subarray(0, lastBreak + 1)
    const [header, ...events] = parseLines(complete.toString('utf-8'))
    if (!header || header.type !== 'session') throw new Error('invalid session')
    const { mtimeMs } = await handle.stat()
    return metadata(file, header, events, { at: mtimeMs, bytes: complete.length })
  } finally {
    await handle.close()
  }
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

async function advanceRow(row) {
  if (typeof row.bytes !== 'number') return metadataFromFile(row.file)
  const info = await stat(row.file)
  if (info.size < row.bytes) return metadataFromFile(row.file)
  if (info.size === row.bytes) return { ...row, at: info.mtimeMs }

  const tail = await readRange(row.file, row.bytes, info.size)
  const lastBreak = tail.lastIndexOf(0x0a)
  if (lastBreak === -1) return { ...row, at: info.mtimeMs }
  const complete = tail.subarray(0, lastBreak + 1)
  const events = parseLines(complete.toString('utf-8'))
  return { ...events.reduce(applyEvent, row), at: info.mtimeMs, bytes: row.bytes + complete.length }
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
  return join(dirname(file), `${DIRTY_PREFIX}${basename(file, '.jsonl')}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function markerOwnerIsAlive(marker) {
  const match = basename(marker).match(/-(\d+)-\d+-[^-]+$/)
  if (!match) return false
  try {
    process.kill(Number(match[1]), 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function acquireIndexLock(dir) {
  await mkdir(dir, { recursive: true })
  return lockfile.lock(dir, {
    lockfilePath: join(dir, '.index.lock'),
    realpath: false,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
  })
}

async function withIndexLock(dir, task) {
  const release = await acquireIndexLock(dir)
  try {
    return await task()
  } finally {
    await release()
  }
}

function enqueueIndexWrite(task) {
  const result = indexWrites.then(task)
  indexWrites = result.catch(() => {})
  return result
}

async function rebuildIndex(dir, names, protectedMarkers = []) {
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

  const activeMarkers = new Set([
    ...protectedMarkers,
    ...[...dirtySessions.values()].map((entry) => entry.marker).filter(Boolean),
  ])
  const staleMarkers = names
    .filter((name) => name.startsWith(DIRTY_PREFIX))
    .map((name) => join(dir, name))
    .filter((marker) => !activeMarkers.has(marker) && !markerOwnerIsAlive(marker))
  await Promise.all(staleMarkers.map((marker) => rm(marker, { force: true })))
  return sessions
}

export function indexedSessions(dir) {
  return enqueueIndexWrite(() => withIndexLock(dir, async () => {
    try {
      const names = await readdir(dir)
      if (names.some((name) => name.startsWith(DIRTY_PREFIX))) return rebuildIndex(dir, names)
      return await readIndex(dir)
    } catch {
      return rebuildIndex(dir)
    }
  }))
}

function dirtySession(file, onError = () => {}) {
  let entry = dirtySessions.get(file)
  if (!entry) {
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

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionIndex().catch(() => {})
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

export function scheduleSessionIndexUpdate(file) {
  dirtySession(file)
  scheduleFlush()
}

async function applyBatch(dir, entries) {
  let sessions
  try {
    sessions = await readIndex(dir)
  } catch {
    sessions = await rebuildIndex(dir, undefined, entries.map((entry) => entry.marker).filter(Boolean))
  }

  const applied = []
  for (const entry of entries) {
    if (removedSessions.has(entry.file)) {
      if (entry.marker) await rm(entry.marker, { force: true })
      continue
    }
    try {
      const at = sessions.findIndex((session) => session.file === entry.file)
      if (at < 0) sessions.push(await metadataFromFile(entry.file))
      else sessions[at] = await advanceRow(sessions[at])
      applied.push(entry)
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (entry.marker) await rm(entry.marker, { force: true })
      } else if (dirtySessions.has(entry.file)) {
        if (entry.marker) await rm(entry.marker, { force: true })
      } else {
        dirtySessions.set(entry.file, entry)
      }
    }
  }
  if (dirtySessions.size > 0) scheduleFlush()
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
  return enqueueIndexWrite(async () => {
    const failures = []
    await Promise.all([...byDir].map(async ([dir, entries]) => {
      try {
        await withIndexLock(dir, () => applyBatch(dir, entries))
      } catch (err) {
        failures.push(err)
        for (const entry of entries) {
          if (removedSessions.has(entry.file)) continue
          const current = dirtySessions.get(entry.file)
          if (current) {
            if (entry.marker) await rm(entry.marker, { force: true })
          } else {
            dirtySessions.set(entry.file, entry)
          }
        }
      }
    }))
    if (failures.length > 0) {
      scheduleFlush()
      throw failures[0]
    }
  })
}

export function removeFromSessionIndex(file) {
  removedSessions.add(file)
  const pending = dirtySessions.get(file)
  dirtySessions.delete(file)
  const dir = dirname(file)
  return enqueueIndexWrite(() => withIndexLock(dir, async () => {
    if (pending?.marker) await rm(pending.marker, { force: true })
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    await writeIndex(dir, sessions.filter((session) => session.file !== file))
  }))
}
