import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome } from './paths.js'
import { parseFrontmatter } from './skills.js'

export function globalPromptsDir() {
  return join(picoHome(), 'prompts')
}

export function promptName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

const promptFile = (name) => join(globalPromptsDir(), `${promptName(name)}.md`)

export async function listPrompts() {
  let files = []
  try { files = await readdir(globalPromptsDir()) } catch { return [] }
  return Promise.all(files.filter((file) => file.endsWith('.md')).sort().map(async (file) => {
    const text = await readFile(join(globalPromptsDir(), file), 'utf-8')
    const { meta, body } = parseFrontmatter(text)
    return { name: file.slice(0, -3), description: meta.description || '', body: body.trim() }
  }))
}

export async function savePrompt({ previous, name, description, body }) {
  const slug = promptName(name)
  if (!slug || !String(body ?? '').trim()) throw new Error('prompt name and text are required')
  await mkdir(globalPromptsDir(), { recursive: true })
  const summary = String(description ?? '').trim().replace(/\s*\n\s*/g, ' ')
  const text = `---\ndescription: ${summary}\n---\n\n${String(body).trim()}\n`
  await writeFile(promptFile(slug), text)
  const old = promptName(previous)
  if (old && old !== slug) await unlink(promptFile(old)).catch(() => {})
  return true
}

export async function removePrompt(name) {
  await unlink(promptFile(name))
  return true
}
