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

const NEW_TOOL_SKILL = `Create a custom pico tool from the user's description.

A pico tool is an ES module whose default export is either a tool object or a factory
\`(context) => tool\` where context is \`{ cwd, root }\`. The tool object shape:

\`\`\`js
export default {
  name: 'word_count',
  description: 'Count words, lines, and characters in a file',
  schema: {
    path: { type: 'string', description: 'file path relative to the working directory' },
    words: { type: 'boolean', description: 'include word count', optional: true },
  },
  execute: async ({ path, words = true }) => {
    // return any JSON-serializable value; throw an Error to report failure
    return { path, words: 42 }
  },
}
\`\`\`

Schema properties support: type (string, number, boolean, array, object), description,
optional, enum (string values), items (for arrays), properties (for nested objects).

Locations: \`.pico/tools/<name>.js\` in the project root for project tools,
\`~/.pico/tools/<name>.js\` for tools available everywhere. Default to the project unless
the user asks for a global tool. Node builtins can be imported; npm packages cannot be
assumed. Tools are rescanned every turn, so a new or edited tool is usable on the next
message with no restart.

Steps:
1. Decide the tool name (snake_case), inputs, and output shape from the user's request.
2. Write the module to the right location with the write tool.
3. Sanity-check it loads: \`node --input-type=module -e "const t = (await import('file://<abs path>')).default; console.log(t.name)"\` (adjust if the export is a factory).
4. Tell the user the tool is ready and will be available from their next message.`

export async function createSkillIndex(root) {
  const builtin = [
    {
      name: 'new-tool',
      description: 'create a custom pico tool from a description of what it should do',
      source: 'builtin',
      body: NEW_TOOL_SKILL,
    },
  ]
  const global = await scanDir(globalSkillsDir(), 'global')
  const project = await scanDir(projectSkillsDir(root), 'project')
  const byName = new Map()
  for (const skill of [...builtin, ...global, ...project]) byName.set(skill.name, skill)
  const skills = [...byName.values()]

  return {
    list: () => skills,
    async load(name) {
      const skill = byName.get(name)
      if (!skill) return null
      if (skill.body) return skill.body
      const { body } = parseFrontmatter(await readFile(skill.file, 'utf-8'))
      return body
    },
  }
}
