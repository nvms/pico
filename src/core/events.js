import { randomUUID } from 'node:crypto'

export const SESSION_VERSION = 1

export function makeEvent(type, data = {}) {
  return { id: randomUUID(), at: Date.now(), type, data }
}

export function makeHeader({ cwd, root }) {
  return {
    type: 'session',
    version: SESSION_VERSION,
    id: randomUUID(),
    cwd,
    root,
    createdAt: Date.now(),
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
