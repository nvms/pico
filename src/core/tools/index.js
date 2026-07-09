import { createRecorder, recorded } from './recorder.js'
import { createRead } from './read.js'
import { createWrite } from './write.js'
import { createEdit } from './edit.js'
import { createBash } from './bash.js'
import { createGlob } from './glob.js'
import { createGrep } from './grep.js'

export function createToolset({ cwd, tracker, skills, shells, mcpTools = [], userTools = [], signal }) {
  const recorder = createRecorder()
  const deps = { cwd, recorder, tracker, signal, shells }

  const local = [
    createRead(deps),
    createWrite(deps),
    createEdit(deps),
    createBash(deps),
    createGlob(deps),
    createGrep(deps),
  ]

  if (shells) {
    local.push(
      {
        name: 'shell_output',
        description: 'Read recent output from a background shell started with bash background: true.',
        schema: {
          id: { type: 'string', description: 'the shell id' },
          tail: { type: 'number', description: 'how many trailing lines to return, default 100', optional: true },
        },
        execute: ({ id, tail = 100 }) => shells.output(id, { tail: Math.min(tail, 500) }),
      },
      {
        name: 'shell_kill',
        description: 'Stop a background shell by id.',
        schema: {
          id: { type: 'string', description: 'the shell id' },
        },
        execute: ({ id }) => shells.kill(id, 'model'),
      },
    )
  }

  if (skills?.list().length) {
    local.push({
      name: 'skill',
      description: `Load a skill by name and follow its instructions. Available skills:\n${skills
        .list()
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n')}`,
      schema: {
        name: { type: 'string', description: 'skill name' },
      },
      execute: async ({ name }) => {
        recorder.extra({ title: name })
        const body = await skills.load(name)
        if (!body) throw new Error(`no skill named ${name}`)
        return { instructions: body }
      },
    })
  }

  const byName = new Map()
  for (const tool of [...local, ...userTools, ...mcpTools]) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  const tools = [...byName.values()].map((tool) => ({
    ...tool,
    execute: recorded(recorder, tool.name, tool.execute),
  }))

  return { tools, recorder }
}
