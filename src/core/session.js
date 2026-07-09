import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, sessionsDir, ensureDir } from './paths.js'
import { makeHeader, serializeLine, parseLines, parseLine } from './events.js'

export function createSession({ cwd, root }) {
  const header = makeHeader({ cwd, root })
  const file = join(ensureDir(sessionsDir(root)), `${header.id}.jsonl`)
  const session = openSession({ file, header })
  session.append(header)
  return session
}

export function openSession({ file, header }) {
  let queue = Promise.resolve()
  return {
    id: header.id,
    file,
    header,
    append(event) {
      queue = queue.then(() => appendFile(file, serializeLine(event)))
      return queue
    },
    flush() {
      return queue
    },
  }
}

export async function loadSession(file) {
  const events = parseLines(await readFile(file, 'utf-8'))
  const header = events[0]?.type === 'session' ? events.shift() : null
  if (!header) throw new Error(`not a pico session file: ${file}`)
  return { header, events }
}

async function sessionMeta(file) {
  const [info, handle] = await Promise.all([stat(file), readFile(file, 'utf-8')])
  const lines = handle.split('\n')
  const header = parseLine(lines[0])
  if (!header || header.type !== 'session') return null
  let title = null
  let color = null
  let turns = 0
  for (const line of lines.slice(1)) {
    const event = parseLine(line)
    if (!event) continue
    if (event.type === 'title') title = event.data.text
    if (event.type === 'color') color = event.data.value
    if (event.type === 'message' && event.data.message?.role === 'user') {
      turns++
      const content = event.data.message.content
      const text = Array.isArray(content)
        ? content.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
        : String(content)
      if (!title && text.trim()) title = text.trim().slice(0, 200)
    }
  }
  if (!title) return null
  return { file, header, title, color, turns, at: info.mtimeMs }
}

async function listDir(dir) {
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n))
  } catch {
    return []
  }
}

export async function listSessions({ scope, root }) {
  let files = []
  if (scope === 'everywhere') {
    const projectsDir = join(picoHome(), 'projects')
    let projects = []
    try {
      projects = await readdir(projectsDir)
    } catch {}
    const nested = await Promise.all(
      projects.map((p) => listDir(join(projectsDir, p, 'sessions'))),
    )
    files = nested.flat()
  } else {
    files = await listDir(sessionsDir(root))
  }
  const metas = await Promise.all(files.map((f) => sessionMeta(f).catch(() => null)))
  return metas.filter(Boolean).sort((a, b) => b.at - a.at)
}
