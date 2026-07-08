import { createRecorder, recorded } from './recorder.js'
import { createRead } from './read.js'
import { createWrite } from './write.js'
import { createEdit } from './edit.js'
import { createBash } from './bash.js'
import { createGlob } from './glob.js'
import { createGrep } from './grep.js'

export function createToolset({ cwd, tracker, skills, mcpTools = [], signal }) {
  const recorder = createRecorder()
  const deps = { cwd, recorder, tracker, signal }

  const local = [
    createRead(deps),
    createWrite(deps),
    createEdit(deps),
    createBash(deps),
    createGlob(deps),
    createGrep(deps),
  ]

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

  const tools = [...local, ...mcpTools].map((tool) => ({
    ...tool,
    execute: recorded(recorder, tool.name, tool.execute),
  }))

  return { tools, recorder }
}
