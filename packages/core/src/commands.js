import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome } from './paths.js'
import { parseFrontmatter } from './skills.js'

const ARGUMENT = /\{\{([A-Za-z][A-Za-z0-9_-]*):(path|text|choice\(([^{}()]*)\))(?:\:([^{}]*))?\}\}/g

export function globalCommandsDir() {
  return join(picoHome(), 'commands')
}

export function projectCommandsDir(root) {
  return join(root, '.pico', 'commands')
}

function inferredLabel(name) {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : name
}

export function parseCommandArguments(body) {
  const arguments_ = []
  const seen = new Set()
  for (const match of body.matchAll(ARGUMENT)) {
    const [, name, typeSpec, choicesText, explicitLabel] = match
    if (seen.has(name)) continue
    const type = typeSpec.startsWith('choice(') ? 'choice' : typeSpec
    const choices = type === 'choice' ? choicesText.split(',').map((v) => v.trim()).filter(Boolean) : undefined
    if (type === 'choice' && choices.length === 0) continue
    seen.add(name)
    arguments_.push({
      name,
      type,
      label: explicitLabel?.trim() || inferredLabel(name),
      ...(choices ? { choices } : {}),
    })
  }
  return arguments_
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
      const text = await readFile(join(dir, file), 'utf-8')
      const { meta, body } = parseFrontmatter(text)
      commands.push({
        name: file.slice(0, -3),
        description: meta.description || '',
        source,
        file: join(dir, file),
        arguments: parseCommandArguments(body),
      })
    } catch {}
  }
  return commands
}

export function expandCommand(body, args = '', namedValues = {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    namedValues = args
    args = ''
  }
  args = String(args ?? '')
  namedValues = namedValues && typeof namedValues === 'object' ? namedValues : {}
  const metadata = new Map(parseCommandArguments(body).map((argument) => [argument.name, argument]))
  const rendered = body.replace(ARGUMENT, (markup, name) => {
    const argument = metadata.get(name)
    if (!argument) return markup
    const value = Object.hasOwn(namedValues, name) ? String(namedValues[name] ?? '') : ''
    if (argument.type === 'choice' && value && !argument.choices.includes(value)) {
      throw new TypeError(`Invalid value for command argument "${name}"`)
    }
    return value
  })
  return rendered.includes('$ARGUMENTS')
    ? rendered.replaceAll('$ARGUMENTS', () => args)
    : args
      ? `${rendered.trim()}\n\n${args}`
      : rendered
}

export async function createCommandIndex(root) {
  const global = await scanDir(globalCommandsDir(), 'global')
  const project = await scanDir(projectCommandsDir(root), 'project')
  const byName = new Map()
  for (const command of [...global, ...project]) byName.set(command.name, command)
  const commands = [...byName.values()]

  return {
    list: () => commands,
    async load(name, args = '', namedValues = {}) {
      const command = byName.get(name)
      if (!command) return null
      const { body } = parseFrontmatter(await readFile(command.file, 'utf-8'))
      return expandCommand(body.trim(), args, namedValues)
    },
  }
}
