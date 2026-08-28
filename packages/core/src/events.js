import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const SESSION_VERSION = 1

export function makeEvent(type, data = {}) {
  return { id: randomUUID(), at: Date.now(), type, data }
}

export function makeHeader({ cwd, root, forkedFrom }) {
  return {
    type: 'session',
    version: SESSION_VERSION,
    id: randomUUID(),
    cwd,
    root,
    createdAt: Date.now(),
    ...(forkedFrom ? { forkedFrom } : {}),
  }
}

export function serializeLine(event) {
  return JSON.stringify(event) + '\n'
}

export function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed.type === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function parseLines(text) {
  return text.split('\n').map(parseLine).filter(Boolean)
}

export async function* streamEvents(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    const event = parseLine(line)
    if (event) yield event
  }
}

export async function readEvents(file) {
  const events = []
  for await (const event of streamEvents(file)) events.push(event)
  return events
}
