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

const ASK_RULE = `Before writing anything, resolve ambiguity:
- If the user did not say global or project, ask exactly one question: "global (available everywhere) or just this project?" Do not guess silently.
- If the behavior or output is underspecified, state the assumptions you are making in one short line before proceeding, so the user can correct you.`

const NEW_TOOL_SKILL = `Create a custom pico tool from the user's description.

${ASK_RULE}

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

const NEW_SKILL_SKILL = `Create a pico skill from the user's description.

${ASK_RULE}

A skill is a markdown file at \`.pico/skills/<name>/SKILL.md\` (project) or
\`~/.pico/skills/<name>/SKILL.md\` (global) with frontmatter and an instruction body:

\`\`\`
---
name: release-notes
description: draft release notes from commits since the last tag
---
Instructions the agent follows when this skill is loaded. Be imperative and specific.
\`\`\`

The description matters most: it is listed in the agent's system prompt, and the agent
decides from it when to load the skill on its own. Write it as a trigger condition
("when the user asks for X"), not marketing. The body is only loaded on invocation, so
it can be long and detailed. Supporting files may sit next to SKILL.md in the same
directory and be referenced by relative path.

Skills are rescanned every turn, so a new skill is usable from the next message.`

const NEW_COMMAND_SKILL = `Create a pico command from the user's description.

${ASK_RULE}

A command is a prompt template the USER invokes as \`/<name> [args]\`. The agent never
sees commands until one is run, so use a command for user-triggered macros and a skill
for capabilities the agent should reach for on its own.

It is a markdown file at \`.pico/commands/<name>.md\` (project) or
\`~/.pico/commands/<name>.md\` (global), optionally with a description in frontmatter:

\`\`\`
---
description: review a file for security problems
---
Review $ARGUMENTS for security problems. Focus on input validation and secrets.
\`\`\`

\`$ARGUMENTS\` is replaced with whatever follows the command; without the placeholder,
arguments are appended after the body. Commands are rescanned every turn, so a new
command appears in the slash menu from the next message.`

export async function createSkillIndex(root) {
  const builtin = [
    {
      name: 'new-tool',
      description: 'create a custom pico tool from a description of what it should do',
      source: 'builtin',
      body: NEW_TOOL_SKILL,
    },
    {
      name: 'new-skill',
      description: 'create a pico skill that teaches the agent a reusable capability',
      source: 'builtin',
      body: NEW_SKILL_SKILL,
    },
    {
      name: 'new-command',
      description: 'create a pico slash command, a prompt template the user invokes',
      source: 'builtin',
      body: NEW_COMMAND_SKILL,
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
