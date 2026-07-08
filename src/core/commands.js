import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome } from './paths.js'
import { parseFrontmatter } from './skills.js'

export function globalCommandsDir() {
  return join(picoHome(), 'commands')
}

export function projectCommandsDir(root) {
  return join(root, '.pico', 'commands')
}

async function scanDir(dir, source) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const commands = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    try {
      const { meta } = parseFrontmatter(await readFile(join(dir, file), 'utf-8'))
      commands.push({
        name: file.slice(0, -3),
        description: meta.description || '',
        source,
        file: join(dir, file),
      })
    } catch {}
  }
  return commands
}

export function expandCommand(body, args) {
  return body.includes('$ARGUMENTS')
    ? body.replaceAll('$ARGUMENTS', args)
    : args
      ? `${body.trim()}\n\n${args}`
      : body
}

export async function createCommandIndex(root) {
  const global = await scanDir(globalCommandsDir(), 'global')
  const project = await scanDir(projectCommandsDir(root), 'project')
  const byName = new Map()
  for (const command of [...global, ...project]) byName.set(command.name, command)
  const commands = [...byName.values()]

  return {
    list: () => commands,
    async load(name, args = '') {
      const command = byName.get(name)
      if (!command) return null
      const { body } = parseFrontmatter(await readFile(command.file, 'utf-8'))
      return expandCommand(body.trim(), args.trim())
    },
  }
}
