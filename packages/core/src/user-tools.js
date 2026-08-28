import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { picoHome } from './paths.js'

export function globalToolsDir() {
  return join(picoHome(), 'tools')
}

export function projectToolsDir(root) {
  return join(root, '.pico', 'tools')
}

function validate(tool, file) {
  if (!tool || typeof tool !== 'object') throw new Error('default export is not a tool object')
  if (typeof tool.name !== 'string' || !tool.name) throw new Error('tool.name must be a string')
  if (typeof tool.description !== 'string') throw new Error('tool.description must be a string')
  if (typeof tool.execute !== 'function') throw new Error('tool.execute must be a function')
  if (!tool.schema || typeof tool.schema !== 'object') throw new Error('tool.schema must be an object')
  return { ...tool, _file: file }
}

async function loadTool(file, context) {
  const { mtimeMs } = await stat(file)
  const module = await import(`${pathToFileURL(file).href}?v=${mtimeMs}`)
  const exported = module.default
  const tool = typeof exported === 'function' ? await exported(context) : exported
  return validate(tool, file)
}

async function scanDir(dir, context, source) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return { tools: [], errors: [] }
  }
  const tools = []
  const errors = []
  for (const name of names) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
    const file = join(dir, name)
    try {
      tools.push({ ...(await loadTool(file, context)), source })
    } catch (err) {
      errors.push({ file, error: String(err.message || err).slice(0, 200) })
    }
  }
  return { tools, errors }
}

export async function scanUserTools({ cwd, root }) {
  const context = { cwd, root }
  const global = await scanDir(globalToolsDir(), context, 'global')
  const project = await scanDir(projectToolsDir(root), context, 'project')
  const byName = new Map()
  for (const tool of [...global.tools, ...project.tools]) byName.set(tool.name, tool)
  return { tools: [...byName.values()], errors: [...global.errors, ...project.errors] }
}
