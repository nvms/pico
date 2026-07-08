import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { globalSkillsDir, projectSkillsDir } from './paths.js'

export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

async function scanDir(dir, source) {
  let names = []
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const file = join(dir, entry.name, 'SKILL.md')
    try {
      const { meta } = parseFrontmatter(await readFile(file, 'utf-8'))
      skills.push({
        name: meta.name || entry.name,
        description: meta.description || '',
        source,
        file,
      })
    } catch {}
  }
  return skills
}

export async function createSkillIndex(root) {
  const global = await scanDir(globalSkillsDir(), 'global')
  const project = await scanDir(projectSkillsDir(root), 'project')
  const byName = new Map()
  for (const skill of [...global, ...project]) byName.set(skill.name, skill)
  const skills = [...byName.values()]

  return {
    list: () => skills,
    async load(name) {
      const skill = byName.get(name)
      if (!skill) return null
      const { body } = parseFrontmatter(await readFile(skill.file, 'utf-8'))
      return body
    },
  }
}
