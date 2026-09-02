import { readFile, readdir, writeFile, mkdir, unlink, rename, access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { picoHome, sharedProjectDir } from './paths.js'
import { parseFrontmatter } from './skills.js'

export function globalMemoryDir() {
  return join(picoHome(), 'memory')
}

export function projectMemoryDir(root) {
  return join(sharedProjectDir(root), 'memory')
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
    const disabled = file.startsWith('_')
    const filename = disabled ? file.slice(1) : file
    try {
      const { meta, body } = parseFrontmatter(await readFile(join(dir, file), 'utf-8'))
      memories.push({
        name: meta.name || filename.slice(0, -3),
        description: meta.description || '',
        scope,
        file: join(dir, file),
        body: body.trim(),
        disabled,
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
      return [...project, ...global].sort((a, b) =>
        a.name.localeCompare(b.name) || Number(a.disabled) - Number(b.disabled) || a.scope.localeCompare(b.scope),
      )
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
    async forget(target) {
      const memories = await this.list()
      const memory = typeof target === 'string'
        ? memories.find((m) => m.name === target && !m.disabled)
        : memories.find((m) => m.file === target.file)
      if (!memory) throw new Error(`no memory named "${typeof target === 'string' ? target : target.name}"`)
      await unlink(memory.file)
      return { name: memory.name, scope: memory.scope }
    },
    async setDisabled(target, disabled) {
      const memories = await this.list()
      const memory = memories.find((m) => m.file === target.file)
      if (!memory) throw new Error(`no memory named "${target.name}"`)
      if (memory.disabled === disabled) return memory
      const filename = basename(memory.file)
      const destination = join(dirname(memory.file), disabled ? `_${filename}` : filename.slice(1))
      try {
        await access(destination)
        throw new Error(`cannot ${disabled ? 'disable' : 'enable'} "${memory.name}": ${basename(destination)} already exists`)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      await rename(memory.file, destination)
      return { ...memory, file: destination, disabled }
    },
    async recall(name) {
      const memories = await this.list()
      const active = memories.filter((m) => !m.disabled)
      const memory = active.find((m) => m.name === name)
      if (!memory) {
        const known = active.map((m) => m.name).join(', ') || 'none'
        throw new Error(`no memory named "${name}"; known memories: ${known}`)
      }
      return { name: memory.name, scope: memory.scope, file: memory.file, content: memory.body }
    },
  }
}

export function memoryIndex(memories, root) {
  const active = memories.filter((m) => !m.disabled)
  if (active.length === 0) {
    return `You have no saved memories yet. This index lists them when you save durable facts with the remember tool; answer questions about your memories from this index alone, without searching the filesystem.`
  }
  const lines = active.map((m) => `- ${m.name} (${m.scope}): ${m.description}`)
  return [
    `Memories you have saved. This index is complete: answer questions about your memories from it directly, load one with the recall tool when its content is relevant, and never search the filesystem for memories. The files live in ${projectMemoryDir(root)} and ${globalMemoryDir()} and can be edited or deleted with ordinary tools when asked to curate them.`,
    ...lines,
  ].join('\n')
}
