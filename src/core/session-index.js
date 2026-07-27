import { writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseLines } from './events.js'

const INDEX_VERSION = 1
const INDEX_FILE = 'index.json'
const DIRTY_PREFIX = '.index-dirty-'
const indexQueues = new Map()

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

export function markSessionIndexDirty(file) {
  const marker = dirtyPath(file)
  writeFileSync(marker, '')
  return marker
}

export function updateSessionIndex(file, header, event, marker = dirtyPath(file)) {
  const dir = dirname(file)
  const queued = (indexQueues.get(dir) || Promise.resolve()).then(async () => {
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    const id = header?.id || basename(file, '.jsonl')
    const index = sessions.findIndex((session) => session.header.id === id)
    const at = Date.now()
    if (index < 0) {
      if (!header) return
      sessions.push(metadata(file, header, event.type === 'session' ? [] : [event], at))
    } else sessions[index] = applyEvent(sessions[index], event, at)
    await writeIndex(dir, sessions)
    await rm(marker, { force: true })
  })
  indexQueues.set(dir, queued.catch(() => {}))
  return queued
}

export function removeFromSessionIndex(file) {
  const dir = dirname(file)
  const id = basename(file, '.jsonl')
  const queued = (indexQueues.get(dir) || Promise.resolve()).then(async () => {
    let sessions
    try {
      sessions = await readIndex(dir)
    } catch {
      return
    }
    await writeIndex(dir, sessions.filter((session) => session.header.id !== id))
  })
  indexQueues.set(dir, queued.catch(() => {}))
  return queued
}
