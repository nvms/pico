import { createRecorder, recorded } from './recorder.js'
import { createRead } from './read.js'
import { createWrite } from './write.js'
import { createEdit } from './edit.js'
import { createBash } from './bash.js'
import { createGlob } from './glob.js'
import { createGrep } from './grep.js'
import { createWebTools } from './web.js'

export function createToolset({ cwd, env, tracker, skills, shells, sessionId, wakeups, memory, agents, askUser, dredge, mcpTools = [], userTools = [], signal, maxToolCalls, maxAgentStarts, requireAgentPlan = false, allowNames }) {
  const recorder = createRecorder()
  let agentStarts = 0
  let plannedAgentStarts = requireAgentPlan ? null : maxAgentStarts
  const deps = { cwd, env, recorder, tracker, signal, shells, sessionId }

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

  if (askUser) {
    local.push({
      name: 'ask_user',
      description: 'Ask the user one or more focused questions when their answers are genuinely needed to continue. Supports free text, one choice, or multiple choices. Do not ask questions you can answer from available context.',
      schema: {
        questions: {
          type: 'array',
          description: 'questions to present, in order',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'short unique identifier' },
              question: { type: 'string', description: 'clear question shown to the user' },
              description: { type: 'string', description: 'brief context explaining why this matters', optional: true },
              type: { type: 'string', enum: ['single', 'multi', 'text'], description: 'answer control' },
              options: {
                type: 'array', optional: true, description: 'choices for single or multi questions',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string', optional: true },
                  },
                  required: ['label'],
                },
              },
              allowOther: { type: 'boolean', optional: true, description: 'allow a custom answer; defaults to true for choice questions' },
            },
            required: ['id', 'question', 'type'],
          },
        },
      },
      execute: ({ questions }) => {
        if (!Array.isArray(questions) || questions.length === 0 || questions.length > 10) throw new Error('ask_user requires 1-10 questions')
        const ids = new Set()
        for (const question of questions) {
          if (!question.id?.trim() || ids.has(question.id)) throw new Error('each question needs a unique non-empty id')
          if (!question.question?.trim()) throw new Error(`question ${question.id} has no prompt`)
          if (!['single', 'multi', 'text'].includes(question.type)) throw new Error(`question ${question.id} has an invalid type`)
          if (question.type !== 'text' && (!Array.isArray(question.options) || question.options.length === 0)) throw new Error(`question ${question.id} needs at least one option`)
          ids.add(question.id)
        }
        return askUser(questions)
      },
    })
  }

  if (agents) {
    local.push(
      {
        name: 'agent_plan',
        description: 'Set the total agent budget for this research run before starting workers. Interpret any user-requested count semantically; otherwise use the configured default. The harness enforces the declared budget.',
        schema: {
          count: { type: 'integer', description: `total agents to permit (1-${maxAgentStarts || 100})` },
          reason: { type: 'string', description: 'brief explanation of how the count follows the user request or research scope' },
        },
        execute: ({ count, reason }) => {
          const ceiling = maxAgentStarts || 100
          if (!Number.isInteger(count) || count < 1 || count > ceiling) throw new Error(`agent budget must be between 1 and ${ceiling}`)
          if (agentStarts > 0) throw new Error('agent budget must be declared before starting agents')
          plannedAgentStarts = count
          return { agentLimit: count, reason }
        },
      },
      {
        name: 'agent_start',
        description: 'Start a background agent for a focused task in the current project. Workers can inspect, modify, and test the project with the configured tools. Returns immediately with an agent id; collect its result with agent_collect.',
        schema: {
          prompt: { type: 'string', description: 'complete, self-contained task and desired output' },
          description: { type: 'string', description: 'short label shown to the user' },
          tools: { type: 'array', items: { type: 'string' }, description: 'tool names to allow; omit for the configured worker tools', optional: true },
        },
        execute: ({ prompt, description, tools }) => {
          if (plannedAgentStarts == null) throw new Error('call agent_plan before starting research agents')
          if (agentStarts >= plannedAgentStarts) throw new Error(`agent limit reached for this run (${plannedAgentStarts}); collect existing agents and finish without spawning more`)
          agentStarts++
          const agent = agents.start({ prompt, description, tools })
          return { agentId: agent.id, status: agent.status, model: agent.model }
        },
      },
      {
        name: 'agent_list',
        description: 'List background agents and their current status.',
        schema: {},
        execute: () => ({ agents: agents.list().map(({ id, description, model, status }) => ({ id, description, model, status })) }),
      },
      {
        name: 'agent_collect',
        description: 'Collect background agent results. Waits for any selected agents that are still running.',
        schema: { ids: { type: 'array', items: { type: 'string' }, description: 'agent ids whose results to collect' } },
        execute: async ({ ids }) => ({ agents: (await agents.collect(ids)).map(({ id, status, result, error }) => ({ id, status, result, error })) }),
      },
      {
        name: 'agent_cancel',
        description: 'Cancel a queued or running background agent.',
        schema: { id: { type: 'string', description: 'agent id' } },
        execute: ({ id }) => ({ cancelled: agents.cancel(id) }),
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
    if (allowNames && !allowNames.includes(tool.name)) continue
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
