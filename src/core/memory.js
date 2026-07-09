import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, projectDir } from './paths.js'
import { parseFrontmatter } from './skills.js'

export function globalMemoryDir() {
  return join(picoHome(), 'memory')
}

export function projectMemoryDir(root) {
  return join(projectDir(root), 'memory')
}

export function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (!slug) throw new Error('memory name must contain letters or numbers')
  return slug
}

async function scanDir(dir, scope) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const memories = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    try {
      const { meta, body } = parseFrontmatter(await readFile(join(dir, file), 'utf-8'))
      memories.push({
        name: meta.name || file.slice(0, -3),
        description: meta.description || '',
        scope,
        file: join(dir, file),
        body: body.trim(),
      })
    } catch {}
  }
  return memories
}

export function createMemory(root) {
  const dirFor = (scope) => (scope === 'global' ? globalMemoryDir() : projectMemoryDir(root))

  return {
    async list() {
      const global = await scanDir(globalMemoryDir(), 'global')
      const project = await scanDir(projectMemoryDir(root), 'project')
      return [...project, ...global]
    },
    async remember({ name, description, content, scope = 'project' }) {
      if (!['project', 'global'].includes(scope)) throw new Error('scope must be project or global')
      const slug = slugify(name)
      const dir = dirFor(scope)
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${slug}.md`)
      const text = `---\nname: ${slug}\ndescription: ${String(description).replace(/\n/g, ' ')}\n---\n${content}\n`
      await writeFile(file, text, 'utf-8')
      return { name: slug, scope, file }
    },
    async recall(name) {
      const memories = await this.list()
      const memory = memories.find((m) => m.name === name)
      if (!memory) {
        const known = memories.map((m) => m.name).join(', ') || 'none'
        throw new Error(`no memory named "${name}"; known memories: ${known}`)
      }
      return { name: memory.name, scope: memory.scope, file: memory.file, content: memory.body }
    },
  }
}

export function memoryIndex(memories, root) {
  if (memories.length === 0) return ''
  const lines = memories.map((m) => `- ${m.name} (${m.scope}): ${m.description}`)
  return [
    `Memories you have saved (load one with the recall tool when relevant; the files live in ${projectMemoryDir(root)} and ${globalMemoryDir()} and can be edited or deleted with ordinary tools when asked to curate them):`,
    ...lines,
  ].join('\n')
}
