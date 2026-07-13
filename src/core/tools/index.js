import { createRecorder, recorded } from './recorder.js'
import { createRead } from './read.js'
import { createWrite } from './write.js'
import { createEdit } from './edit.js'
import { createBash } from './bash.js'
import { createGlob } from './glob.js'
import { createGrep } from './grep.js'
import { createWebTools } from './web.js'

export function createToolset({ cwd, tracker, skills, shells, wakeups, memory, dredge, mcpTools = [], userTools = [], signal, maxToolCalls }) {
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

  if (dredge) {
    local.push(...createWebTools({ dredge, recorder, signal }))
  }

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

  if (wakeups) {
    local.push(
      {
        name: 'schedule_wakeup',
        description: 'Schedule a one-time wake-up: after the delay you receive a system notification carrying your note and can act on it. For a recurring loop, schedule the next wake-up at the end of each one. Do not use this to poll a background shell; its exit already notifies you. Wake-ups are lost if pico exits.',
        schema: {
          delaySeconds: { type: 'number', description: 'seconds from now, minimum 5' },
          note: { type: 'string', description: 'what to do when you wake up; written to your future self' },
        },
        execute: ({ delaySeconds, note }) => {
          const { id, at, seconds } = wakeups.schedule(delaySeconds, note)
          return { wakeupId: id, firesAt: new Date(at).toString(), inSeconds: seconds }
        },
      },
      {
        name: 'cancel_wakeup',
        description: 'Cancel a pending wake-up by id.',
        schema: {
          id: { type: 'string', description: 'the wake-up id' },
        },
        execute: ({ id }) => wakeups.cancel(id),
      },
      {
        name: 'list_wakeups',
        description: 'List your pending scheduled wake-ups: id, when each fires, and its note.',
        schema: {},
        execute: () => ({
          wakeups: wakeups.list().map((w) => ({
            id: w.id,
            firesAt: new Date(w.at).toString(),
            inSeconds: Math.max(0, Math.round((w.at - Date.now()) / 1000)),
            note: w.note,
          })),
        }),
      },
    )
  }

  if (memory) {
    local.push(
      {
        name: 'remember',
        description: 'Save a durable memory for future sessions. Use for corrections, preferences, and non-obvious facts worth keeping: a flaky test, a build quirk, something the user asked you to remember. Do not save what the code or git history already records, or details that only matter this session. Never duplicate what a skill or AGENTS.md already covers: those are already in your context every session, and a memory copy goes stale the moment they are edited. If asked to learn something a skill covers, say the skill already covers it instead of saving. Choose scope by applicability: if the fact would hold in a different project, use global; if it is tied to this codebase or how the user works here, use project. Always state the chosen scope in your reply so the user can correct it, and if applicability is genuinely unclear, ask before saving.',
        schema: {
          name: { type: 'string', description: 'short kebab-case identifier' },
          description: { type: 'string', description: 'one line used to decide when to recall this; write it as a hook, not a summary' },
          content: { type: 'string', description: 'the memory itself' },
          scope: { type: 'string', enum: ['project', 'global'], optional: true },
        },
        execute: async ({ name, description, content, scope }) => {
          const saved = await memory.remember({ name, description, content, scope })
          recorder.extra({ title: `${saved.name} (${saved.scope})` })
          return saved
        },
      },
      {
        name: 'recall',
        description: 'Load the full content of a saved memory by name. Your memory index is in the system prompt.',
        schema: {
          name: { type: 'string', description: 'the memory name from the index' },
        },
        execute: async ({ name }) => {
          const found = await memory.recall(name)
          recorder.extra({ title: found.name })
          return found
        },
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
    execute: recorded(recorder, tool.name, async (args) => {
      if (maxToolCalls && recorder.entries.length >= maxToolCalls) {
        throw new Error('tool call limit reached for this run; do not call more tools, summarize what you have and finish')
      }
      return tool.execute(args)
    }),
  }))

  return { tools, recorder }
}
