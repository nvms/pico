import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEvent } from './events.js'
import { createSession, forkSession, openSession, loadSession, listSessions, deleteSession, appendSessionEvent, onSessionWriteError } from './session.js'
import { createContextTracker } from './context.js'
import { deriveState, userEntries, rewindStats } from './derive.js'
import { appendPrompt } from './history.js'
import { runTurn, summarizeText, compactHistory, compactProgress } from './agent.js'
import { createAgentManager } from './agents.js'
import { runDeliberation, validateDeliberation } from './deliberation.js'
import { deliberationsFromEvents } from './deliberation-history.js'
import { compactionPrompt, formatCompactSummary, summarySections, compactionKeepFrom } from './compaction.js'
import { createToolset } from './tools/index.js'
import { defaultTitle } from './tools/recorder.js'
import { scanUserTools } from './user-tools.js'
import { createSkillIndex } from './skills.js'
import { createCommandIndex } from './commands.js'
import { initPrompt } from './init.js'
import { revertEdits, reapplyEdits } from './rewind.js'
import { buildSystemPrompt } from './system-prompt.js'
import { memoryIndex } from './memory.js'
import { transcriptToMarkdown } from './export.js'
import { findModel, estimateCost } from './models.js'
import { adhocModel } from './catalog.js'
import { writeConfig } from './config.js'
import { connectOpenAI, openaiCredentials, disconnectOpenAI } from './openai-auth.js'
import { agentScratchDir, ensureDir } from './paths.js'
import { loadCodexModels } from './codex-models.js'
import { fuzzyScore } from './fuzzy.js'
import { finalizeUserContent, inputTextFromContent, mediaTypeFor } from './attachments.js'

export const EFFORT_LEVELS = [
  { key: null, desc: 'let the provider decide how much to think' },
  { key: 'low', desc: 'quick answers, minimal thinking' },
  { key: 'medium', desc: 'moderate thinking budget' },
  { key: 'high', desc: 'generous thinking budget' },
  { key: 'max', desc: 'maximum thinking budget' },
]

export const SESSION_COLORS = {
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#6BE795',
  teal: '#2dd4bf',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  purple: '#a78bfa',
  pink: '#f472b6',
  gray: '#9ca3af',
}

const WORKER_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'shell_output', 'shell_kill', 'web_search', 'web_fetch']
const AGENT_TOOLS = ['agent_plan', 'agent_start', 'agent_list', 'agent_collect', 'agent_cancel']
const CONTEXT_COLORS = ['#67b7ff', '#c792ea', '#f7c66a', '#f78c6c', '#6be795']

function createEmitter() {
  const listeners = new Map()
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      return () => listeners.get(type)?.delete(fn)
    },
    emit(type, payload) {
      for (const fn of [...(listeners.get(type) || [])]) fn(payload)
    },
  }
}

function parallelPrompt(task, agentLimit) {
  return `Use parallel agents for the following task: ${task}\n\nFirst call agent_plan. Interpret any agent-count instruction in the user's task semantically and declare that count; if the user gave no count, declare the configured default budget of ${agentLimit}. Then use agent_start within that enforced budget to delegate distinct, focused parts of the task to the configured worker model. Collect workers with agent_collect, critically evaluate their results, and synthesize the final response. When useful and the budget permits, use independent workers to check important disputed or weak conclusions. Do not delegate final synthesis. Do not emit progress updates while agents run; Pico displays agent activity automatically.`
}

function deliberatePrompt(decision) {
  return `Deliberate on the following decision: ${decision}\n\nImmediately call deliberate with a self-contained brief. Do not research first, start ordinary agents, or approximate the deliberation yourself. The deliberation participants own all supporting research.`
}

function workerSystemPrompt(scratchpad) {
  return `You are an isolated worker operating in the user's real project. Complete only the assigned task and do not ask the user questions. You may read, modify, and test project files. Put disposable scripts, generated data, experiments, and temporary package installs in your session-persistent scratchpad at ${scratchpad}, also available as $PICO_SCRATCHPAD. Use primary sources where possible, distinguish evidence from inference, and return a concise self-contained result.`
}

function participantSystemPrompt(scratchpad) {
  return `You are one participant in an isolated, bounded deliberation. Research actively with project and web tools, prefer primary sources, and distinguish evidence from inference. Do not ask the user questions or modify project files. Your persistent scratchpad is ${scratchpad}.`
}

function shellRuntime(shell) {
  const secs = Math.max(0, Math.round(((shell.endedAt || Date.now()) - shell.startedAt) / 1000))
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function errorText(err, limit) {
  return String(err?.message || err).slice(0, limit)
}

export function createController({ boot }) {
  const { on, emit } = createEmitter()

  const state = {
    session: null,
    events: [],
    persisted: 0,
    derived: deriveState([]),
    model: boot.initialModel,
    defaultModel: boot.initialModel,
    effort: boot.initialEffort,
    defaultEffort: boot.initialEffort,
    busy: false,
    compacting: false,
    compactStatus: null,
    turnPhase: 'idle',
    startedAt: 0,
    overlay: [],
    streaming: null,
    queued: [],
    expedited: [],
    sent: [],
    question: null,
    rewindUndo: null,
    attachments: new Map(),
    imageCount: 0,
    activityVersion: 0,
    held: false,
  }

  let abort = null
  let sendAfterToolTriggered = false
  let nextResearchAgentLimit = null
  let pendingSystemNotes = []
  const warnedTools = new Set()

  const changed = () => emit('change', state)
  const flash = (message) => emit('flash', message)

  function set(patch) {
    Object.assign(state, patch)
    changed()
  }

  function bumpActivity() {
    set({ activityVersion: state.activityVersion + 1 })
  }

  function persist(event) {
    state.events.push(event)
    if (state.session) {
      state.session.append(event)
      state.persisted = state.events.length
    }
  }

  function ensureSession() {
    if (!state.session) state.session = createSession({ cwd: boot.cwd, root: boot.root })
    while (state.persisted < state.events.length) {
      state.session.append(state.events[state.persisted])
      state.persisted++
    }
  }

  function reDerive() {
    state.derived = deriveState(state.events)
    emit('derived', state.derived)
    changed()
  }

  async function codexAuth() {
    if (state.model.provider !== 'codex') return { auth: null, ok: true }
    const auth = await openaiCredentials().catch(() => null)
    if (!auth) flash('codex models need a ChatGPT sign-in: run /connect')
    return { auth, ok: !!auth }
  }

  const agents = createAgentManager({
    concurrency: 8,
    defaults: () => ({ model: boot.researchModel }),
    onChange: bumpActivity,
    onCreate: (agent) => persist(makeEvent('agent_start', { agentId: agent.id, description: agent.description, prompt: agent.prompt, model: agent.model, role: agent.role, sessionId: agent.sessionId, sessionFile: agent.sessionFile, tools: agent.tools })),
    onEvent: (agent, event) => {
      if (['tool_executing', 'tool_complete', 'tool_error', 'usage'].includes(event.type)) persist(makeEvent('agent_event', { agentId: agent.id, event }))
    },
    onFinish: (agent) => {
      persist(makeEvent('agent_result', { agentId: agent.id, result: agent.result, usage: agent.usage, interrupted: agent.status === 'cancelled', error: agent.error }))
      noteSystem(`Agent ${agent.id} (${agent.description}) finished with status ${agent.status}. Its result is ready. Call agent_collect with id ${agent.id} before finishing your response.`, { wake: true, agentId: agent.id, sessionId: agent.sessionId, sessionFile: agent.sessionFile })
    },
    // this closure outlives any single boot: /connect and project switches
    // both replace boot fields, so it reads the live boot every run
    run: async (agent, signal, onStream) => {
      const worker = boot.models.find((m) => m.name === agent.model)
      if (!worker || worker.available === false) throw new Error(`research model unavailable: ${agent.model}`)
      const auth = worker.provider === 'codex' ? await openaiCredentials() : null
      const sessionId = state.session?.id
      if (!sessionId) throw new Error('worker requires an active session')
      const scratchpad = ensureDir(agentScratchDir(boot.root, sessionId, agent.id))
      const requestedTools = agent.tools?.length ? agent.tools.filter((name) => WORKER_TOOLS.includes(name)) : WORKER_TOOLS
      const { tools, recorder } = createToolset({
        cwd: boot.cwd,
        env: { PICO_SCRATCHPAD: scratchpad },
        // a private tracker seeded from the main one: a worker may read an
        // AGENTS.md the main agent has not seen, and consuming it from the
        // shared set would mean the main agent never receives it
        tracker: createContextTracker({ stopDir: boot.startupContext.stopDir, loaded: new Set(boot.tracker.loaded) }),
        shells: boot.shells,
        sessionId,
        sessionFile: state.session?.file,
        dredge: boot.dredge,
        signal,
        maxToolCalls: 30,
        allowNames: requestedTools,
      })
      return runTurn({
        history: [{ role: 'user', content: agent.prompt }],
        tools,
        recorder,
        modelName: worker.name,
        effort: worker.effort ? 'low' : null,
        auth,
        system: workerSystemPrompt(scratchpad),
        signal,
        onStream,
      })
    },
  })

  const deliberations = {
    run: async ({ brief, rounds, signal }) => {
      const options = validateDeliberation({ brief, rounds })
      brief = options.brief
      rounds = options.rounds
      const existingIds = deliberationsFromEvents(state.events).map((item) => Number(item.deliberationId)).filter(Number.isFinite)
      const id = String(Math.max(0, ...existingIds) + 1)
      const modelName = boot.deliberationModel
      const worker = boot.models.find((m) => m.name === modelName)
      if (!worker || worker.available === false) throw new Error(`deliberation model unavailable: ${modelName}`)
      const auth = worker.provider === 'codex' ? await openaiCredentials() : null
      const sessionId = state.session?.id
      if (!sessionId) throw new Error('deliberation requires an active session')
      persist(makeEvent('deliberation_start', { deliberationId: id, brief, rounds, model: modelName }))
      bumpActivity()

      const persistDeliberation = (event) => {
        persist(event)
        bumpActivity()
      }

      const runWorker = async ({ history, role, tools: enabled = true, onStream }) => {
        const scratchpad = ensureDir(agentScratchDir(boot.root, sessionId, `deliberation-${id}-${role}`))
        const toolset = createToolset({
          cwd: boot.cwd,
          env: { PICO_SCRATCHPAD: scratchpad },
          tracker: createContextTracker({ stopDir: boot.startupContext.stopDir, loaded: new Set(boot.tracker.loaded) }),
          shells: boot.shells,
          sessionId,
          sessionFile: state.session?.file,
          dredge: boot.dredge,
          signal,
          maxToolCalls: 30,
          allowNames: enabled ? WORKER_TOOLS : [],
        })
        return runTurn({
          history,
          tools: toolset.tools,
          recorder: toolset.recorder,
          modelName,
          effort: worker.effort ? 'low' : null,
          auth,
          system: participantSystemPrompt(scratchpad),
          signal,
          onStream,
        })
      }

      const result = await runDeliberation({
        brief,
        rounds,
        signal,
        runParticipant: ({ history, role, round }) => runWorker({
          history,
          role,
          onStream: (event) => {
            if (['tool_executing', 'tool_complete', 'tool_error'].includes(event.type)) {
              persistDeliberation(makeEvent('deliberation_event', { deliberationId: id, role, round, event }))
            }
          },
        }),
        runSynthesis: ({ history }) => runWorker({ history, role: 'synthesizer', tools: false }),
        onEvent: (event) => persistDeliberation(makeEvent('deliberation_turn', { deliberationId: id, ...event })),
      })
      persistDeliberation(makeEvent('deliberation_result', { deliberationId: id, result: result.result, usage: result.usage, interrupted: result.interrupted, error: result.error }))
      if (result.error) throw new Error(result.error)
      return {
        deliberationId: id,
        synthesis: result.result,
        interrupted: result.interrupted,
        review: 'The full deliberation transcript and tool activity are available in the session activity panel.',
      }
    },
  }

  onSessionWriteError((err) => flash(`session not saved: ${errorText(err, 80)}`))
  boot.setMcpNotify(() => emit('mcp', boot.mcp.list()))
  boot.setShellsNotify(() => emit('shells'))
  boot.setWakeupsNotify(() => emit('shells'))
  boot.setGitNotify(() => emit('git'))
  boot.setWakeupsFire((wakeup) => {
    flash(`wake-up ${wakeup.id} fired`)
    noteSystem(`[system notification] scheduled wake-up ${wakeup.id} fired. Note to self: ${wakeup.note}`, { wake: true })
  })
  boot.setShellsExit((shell) => {
    if (shell.killedBy === 'model') {
      flash(`shell ${shell.id} killed`)
      return
    }
    if (shell.killedBy === 'user') {
      flash(`shell ${shell.id} killed`)
      noteSystem(`[system notification] the user manually killed background shell ${shell.id} (${shell.description || shell.command}) from the shells panel (SIGTERM). This was deliberate; do not restart it unless asked.`, { wake: false, sessionId: shell.sessionId, sessionFile: shell.sessionFile })
      return
    }
    flash(`shell ${shell.id} exited · code ${shell.exitCode}`)
    const tail = boot.shells.output(shell.id, { tail: 30 }).output
    noteSystem(
      `[system notification] background shell ${shell.id} (${shell.description || shell.command}) exited with code ${shell.exitCode} after ${shellRuntime(shell)}.` +
        (tail ? `\nRecent output:\n${tail}` : ''),
      { wake: true, sessionId: shell.sessionId, sessionFile: shell.sessionFile },
    )
  })

  function noteSystem(text, { wake, agentId, sessionId = state.session?.id, sessionFile = state.session?.file } = {}) {
    pendingSystemNotes.push({ text, wake, agentId, sessionId, sessionFile })
    flushSystemNotes()
  }

  function discardCollectedAgentNotes(agentIds) {
    const collected = new Set(agentIds.map(String))
    pendingSystemNotes = pendingSystemNotes.filter((note) => !collected.has(String(note.agentId)))
  }

  function flushSystemNotes() {
    if (!pendingSystemNotes.length || state.busy || state.held || !state.session) return
    pendingSystemNotes = pendingSystemNotes.filter((note) => !note.agentId || !agents.get(note.agentId)?.collectedAt)
    const currentSessionId = state.session.id
    const current = pendingSystemNotes.filter((note) => !note.sessionId || note.sessionId === currentSessionId)
    const elsewhere = pendingSystemNotes.filter((note) => note.sessionId && note.sessionId !== currentSessionId)
    pendingSystemNotes = []
    for (const notes of Map.groupBy(elsewhere, (note) => note.sessionId).values()) {
      const sessionFile = notes.find((note) => note.sessionFile)?.sessionFile
      if (sessionFile) appendSessionEvent(sessionFile, makeEvent('system_note', { text: notes.map((n) => n.text).join('\n\n') }))
    }
    if (!current.length) return
    persist(makeEvent('system_note', { text: current.map((n) => n.text).join('\n\n') }))
    reDerive()
    if (current.some((n) => n.wake)) runAgentTurn()
  }

  function hold(held) {
    set({ held })
    if (!held) flushSystemNotes()
  }

  function flushStream(items) {
    if (state.streaming) items.push({ kind: 'assistant', text: state.streaming })
    state.streaming = null
  }

  async function executeTurn(text) {
    const { content } = finalizeUserContent(text, state.attachments)
    persist(makeEvent('message', { message: { role: 'user', content } }))
    ensureSession()
    reDerive()
    await runAgentTurn()
  }

  function takePending() {
    const next = [...state.expedited, ...state.queued]
    set({ expedited: [], queued: [] })
    return next
  }

  async function compact(instructions = '') {
    if (state.busy || state.compacting) return flash('finish or interrupt the current turn first')
    const current = state.derived
    if (current.providerHistory.length < 4) return flash('nothing to compact yet')

    const controller = new AbortController()
    abort = controller
    set({ busy: true, compacting: true, compactStatus: null, startedAt: Date.now() })

    const { auth, ok } = await codexAuth()
    if (!ok) {
      abort = null
      set({ compacting: false, busy: false })
      return
    }

    const keepFrom = compactionKeepFrom(current, state.model.context)
    let streamed = ''
    try {
      const raw = await compactHistory({
        history: current.providerHistory,
        modelName: state.model.name,
        auth,
        prompt: compactionPrompt(instructions),
        signal: controller.signal,
        onStream: (event) => {
          if (event.type !== 'content') return
          streamed += event.content
          set({ compactStatus: compactProgress(streamed) })
        },
      })
      const summary = formatCompactSummary(raw)
      if (!summary) throw new Error('empty summary')
      if (summarySections(summary) < 5) throw new Error('malformed summary, conversation left untouched')
      persist(makeEvent('compact', { summary, keepFrom, sessionFile: state.session?.file || null }))
      reDerive()
      flash('compacted · recent messages kept verbatim')
    } catch (err) {
      if (controller.signal.aborted) flash('compaction cancelled')
      else flash(`compact failed: ${errorText(err, 100)}`)
    } finally {
      abort = null
      set({ compacting: false, compactStatus: null, busy: false })
    }

    if (state.expedited.length > 0 || state.queued.length > 0) {
      const next = takePending()
      if (controller.signal.aborted) emit('input', next.join('\n'))
      else {
        executeTurn(next.join('\n'))
        return
      }
    }
    flushSystemNotes()
  }

  function maybeAutoCompact() {
    if (boot.autoCompact === false || state.busy || state.compacting) return
    const limit = state.model.context
    const used = state.derived.lastPromptTokens
    if (!limit || !used || state.derived.lastPromptModel !== state.model.name) return
    const ratio = used / limit
    if (ratio >= 0.85) {
      flash(`context ${Math.round(ratio * 100)}% full · auto-compacting`)
      compact()
    }
  }

  async function refreshProjectIndexes() {
    boot.skills = await createSkillIndex(boot.root).catch(() => boot.skills) ?? boot.skills
    boot.commands = await createCommandIndex(boot.root).catch(() => boot.commands) ?? boot.commands
    const scan = await scanUserTools({ cwd: boot.cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
    for (const failure of scan.errors) {
      const key = `${failure.file}:${failure.error}`
      if (warnedTools.has(key)) continue
      warnedTools.add(key)
      flash(`tool skipped: ${failure.file.split('/').pop()} · ${failure.error}`)
    }
    return scan
  }

  function askUser(questions) {
    return new Promise((resolve) => {
      set({ question: { questions, resolve } })
      emit('question', state.question)
    })
  }

  function updateOverlay(fn) {
    state.overlay = fn(state.overlay)
    changed()
  }

  function onToolUpdate(pending) {
    if (pending.name !== 'bash') return
    updateOverlay((items) => items.map((item) =>
      item.kind === 'tool' && item.callId === pending.callId
        ? { ...item, fullOutput: pending.fullOutput, outputLineStart: pending.outputLineStart, outputLineCount: pending.outputLineCount }
        : item,
    ))
  }

  function streamHandler(recorder, controller) {
    return (event) => {
      if (event.type === 'thinking') {
        updateOverlay((items) => {
          const next = [...items]
          flushStream(next)
          const last = next.at(-1)
          if (last?.kind === 'thoughts') last.text += event.content
          else next.push({ kind: 'thoughts', text: event.content })
          return next
        })
        set({ turnPhase: 'thinking' })
      } else if (event.type === 'content') {
        set({ turnPhase: 'responding', streaming: (state.streaming || '') + event.content })
      } else if (event.type === 'tool_calls_ready') {
        set({ turnPhase: 'tools' })
        updateOverlay((items) => {
          const next = [...items]
          flushStream(next)
          return next
        })
      } else if (event.type === 'tool_executing') {
        updateOverlay((items) => {
          const next = [...items]
          flushStream(next)
          let args = {}
          try {
            args = JSON.parse(event.call.function.arguments)
          } catch {}
          next.push({
            kind: 'tool',
            callId: event.call.id,
            name: event.call.function.name,
            description: args.description,
            title: defaultTitle(event.call.function.name, args),
            titleLang: event.call.function.name === 'bash' ? 'bash' : null,
            status: 'running',
            startedAt: Date.now(),
          })
          return next
        })
      } else if (event.type === 'tool_complete' || event.type === 'tool_error') {
        boot.git.refresh()
        const entry = recorder.entries.at(-1)
        updateOverlay((items) =>
          items.map((item) =>
            item.kind === 'tool' && item.callId === event.call.id
              ? { ...item, ...(entry?.callId === event.call.id ? entry : {}), kind: 'tool', status: entry?.status || 'done' }
              : item,
          ),
        )
        if (state.expedited.length > 0) {
          sendAfterToolTriggered = true
          controller.abort()
        }
      }
    }
  }

  async function runAgentTurn() {
    const researchAgentLimit = nextResearchAgentLimit || null
    nextResearchAgentLimit = null
    emit('turn', 'start')
    set({ busy: true, turnPhase: 'responding', startedAt: Date.now() })

    const { auth, ok } = await codexAuth()
    if (!ok) {
      set({ turnPhase: 'idle', busy: false })
      flushSystemNotes()
      return
    }

    const controller = new AbortController()
    abort = controller
    const { tracker } = boot
    const loadedBefore = new Set(tracker.loaded)
    const userToolScan = await refreshProjectIndexes()
    const freshSkills = boot.skills
    const { tools, recorder } = createToolset({
      cwd: boot.cwd,
      tracker,
      skills: freshSkills,
      shells: boot.shells,
      sessionId: state.session?.id,
      sessionFile: state.session?.file,
      wakeups: boot.wakeups,
      memory: boot.memory,
      agents: boot.researchModel ? agents : null,
      deliberations: boot.deliberationModel ? deliberations : null,
      onAgentsCollected: discardCollectedAgentNotes,
      askUser,
      dredge: boot.dredge,
      mcpTools: boot.mcp.tools(),
      userTools: userToolScan.tools,
      signal: controller.signal,
      maxAgentStarts: researchAgentLimit ? 100 : undefined,
      requireAgentPlan: !!researchAgentLimit,
      allowNames: researchAgentLimit ? AGENT_TOOLS : undefined,
      onToolUpdate,
    })

    sendAfterToolTriggered = false
    let result
    try {
      result = await runTurn({
        history: state.derived.providerHistory,
        tools,
        recorder,
        modelName: state.model.name,
        effort: effortApplies() ? state.effort ?? 'auto' : null,
        auth,
        system: buildSystemPrompt({
          cwd: boot.cwd,
          contextFiles: boot.startupContext.files,
          skills: freshSkills.list(),
          memoryIndexText: memoryIndex(await boot.memory.list().catch(() => []), boot.root),
        }),
        signal: controller.signal,
        onStream: streamHandler(recorder, controller),
      })
    } catch (err) {
      abort = null
      set({ overlay: [], streaming: null, turnPhase: 'idle', busy: false })
      flash(`error: ${errorText(err, 120)}`)
      return
    }

    const turnTranscript = [...state.overlay]
    flushStream(turnTranscript)
    for (const message of result.messages) persist(makeEvent('message', { message, hideFromTranscript: true }))
    persist(makeEvent('turn_transcript', { items: turnTranscript }))
    for (const entry of recorder.entries) persist(makeEvent('tool_meta', entry))
    for (const path of tracker.loaded) {
      if (!loadedBefore.has(path)) persist(makeEvent('context_file', { path }))
    }
    if (result.usage) persist(makeEvent('usage', { model: state.model.name, usage: result.usage, lastPrompt: result.lastPromptTokens }))
    if (result.interrupted) persist(makeEvent('interrupt', {}))

    abort = null
    state.overlay = []
    state.streaming = null
    state.turnPhase = 'idle'
    state.busy = false
    reDerive()
    boot.git.refresh()
    if (result.stalled) {
      flash('model stalled · turn interrupted')
      noteSystem(
        '[system notification] the previous turn was cut off automatically: the model produced no output for 5 minutes (provider stall). Work may have stopped mid-task; pick up where it left off.',
        { wake: false },
      )
    } else if (result.error) {
      flash(`error: ${result.error.slice(0, 120)}`)
      noteSystem(
        `[system notification] the previous turn ended with a provider error: ${result.error.slice(0, 300)}. Work may have stopped mid-task; pick up where it left off.`,
        { wake: false },
      )
    }

    const expeditedMessages = state.expedited
    const pendingMessages = state.queued
    if (expeditedMessages.length > 0 || pendingMessages.length > 0) {
      set({ expedited: [], queued: [] })
      if (result.interrupted && !sendAfterToolTriggered) {
        emit('input', [...expeditedMessages, ...pendingMessages].join('\n'))
      } else {
        const next = sendAfterToolTriggered ? expeditedMessages : [...expeditedMessages, ...pendingMessages]
        if (sendAfterToolTriggered && pendingMessages.length > 0) set({ queued: pendingMessages })
        executeTurn(next.join('\n'))
        return
      }
    }
    flushSystemNotes()
    maybeAutoCompact()
  }

  function send(text) {
    const value = text.trim()
    if (!value) return
    state.sent = [...state.sent, { text: value, at: Date.now() }]
    appendPrompt(boot.root, value).catch(() => {})
    if (state.busy) {
      set({ queued: [...state.queued, value] })
      return
    }
    changed()
    executeTurn(value)
  }

  function interrupt() {
    if (!state.busy) return
    sendAfterToolTriggered = false
    cancelQuestion()
    abort?.abort()
  }

  function answerQuestion(answers) {
    const request = state.question
    if (!request) return
    set({ question: null })
    request.resolve({ answers })
  }

  function cancelQuestion() {
    const request = state.question
    if (!request) return
    set({ question: null })
    request.resolve({ cancelled: true })
  }

  function recallPending() {
    const next = takePending()
    return next.join('\n')
  }

  function expediteQueued() {
    set({ expedited: [...state.expedited, ...state.queued], queued: [] })
  }

  function resetConversation({ model, effort } = {}) {
    state.session = null
    state.events = []
    state.persisted = 0
    state.rewindUndo = null
    state.queued = []
    state.expedited = []
    state.sent = []
    state.model = model ?? state.defaultModel
    state.effort = effort === undefined ? state.defaultEffort : effort
  }

  function newSession() {
    if (state.busy) return flash('finish or interrupt the current turn first')
    resetConversation()
    agents.clear()
    reDerive()
    emit('session', state.session)
    flash('new session')
  }

  async function deleteCurrentSession() {
    const { session } = state
    if (!session) return false
    if (state.busy) {
      flash('finish or interrupt the current turn first')
      return false
    }
    try {
      await session.flush()
      await deleteSession(session.file)
    } catch (err) {
      flash(`delete failed: ${errorText(err, 80)}`)
      return false
    }
    resetConversation()
    reDerive()
    emit('session', state.session)
    flash('session deleted')
    return true
  }

  async function fork(label) {
    if (!label) return flash('usage: /fork <label>')
    if (state.busy) return flash('finish or interrupt the current turn first')
    ensureSession()
    const forked = await forkSession({ source: state.session, cwd: boot.cwd, root: boot.root, events: state.events, label })
    state.session = forked.session
    state.events = forked.events
    state.persisted = forked.events.length
    state.rewindUndo = null
    state.queued = []
    state.expedited = []
    state.sent = []
    agents.restore(forked.events)
    reDerive()
    emit('session', state.session)
    flash(`forked session as "${label}"`)
  }

  function rename(text) {
    const automaticTitle = userEntries(state.derived)[0]?.text.trim().slice(0, 200)
    persist(makeEvent('title', { text: text || null }))
    ensureSession()
    reDerive()
    if (text) flash(`session renamed to "${text}"`)
    else if (automaticTitle) flash(`session name reset to "${automaticTitle}"`)
    else flash('session name reset')
  }

  function setColor(input = '') {
    const names = Object.keys(SESSION_COLORS)
    const values = Object.values(SESSION_COLORS)
    let value
    if (!input) {
      value = values[(values.indexOf(state.derived.color) + 1) % values.length]
    } else if (input.toLowerCase() === 'none') {
      value = null
    } else {
      value = SESSION_COLORS[input.toLowerCase()] || (/^#[0-9a-fA-F]{6}$/.test(input) ? input : null)
      if (!value) return flash(`usage: /color to cycle, /color none to clear, or /color <${names.join('|')}|#hex>`)
    }
    persist(makeEvent('color', { value }))
    ensureSession()
    reDerive()
    flash(value ? `session color: ${names[values.indexOf(value)] || value}` : 'session color cleared')
  }

  function clear() {
    if (state.busy) return flash('finish or interrupt the current turn first')
    persist(makeEvent('clear', {}))
    reDerive()
    flash('conversation cleared')
  }

  function recallText(entry) {
    return inputTextFromContent(entry.content ?? entry.text, {
      attachments: state.attachments,
      nextId: () => ++state.imageCount,
    })
  }

  function attachImage(path) {
    const mediaType = mediaTypeFor(path)
    if (!mediaType) return null
    const placeholder = `[Image #${++state.imageCount}]`
    state.attachments.set(placeholder, { path, mediaType })
    return placeholder
  }

  function attachProjectFile(file) {
    const full = join(boot.cwd, file)
    if (!mediaTypeFor(file) || !existsSync(full)) return null
    return attachImage(full)
  }

  function detachImage(placeholder) {
    state.attachments.delete(placeholder)
  }

  function restoreModelFromSession() {
    const name = state.derived.model
    const catalogMatch = boot.models.find((m) => m.name === name && m.available !== false)
    const restored = name && (catalogMatch || adhocModel(name, boot.providers))
    if (restored) {
      state.model = restored
      return
    }
    state.model = state.defaultModel
    if (name) flash(`model ${name} unavailable, using ${state.defaultModel.name}`)
  }

  async function resume(meta) {
    if (state.busy) return flash('finish or interrupt the current turn before switching sessions')
    if (meta.header.root !== boot.root) return switchProject(meta)
    try {
      const { header, events } = await loadSession(meta.file)
      state.session = openSession({ file: meta.file, header })
      state.events = [...events]
      state.persisted = events.length
      state.rewindUndo = null
      agents.restore(events)
      reDerive()
      restoreModelFromSession()
      state.effort = state.derived.effort === undefined ? state.defaultEffort : state.derived.effort
      state.sent = userEntries(state.derived).map((e) => ({ text: recallText(e), at: header.createdAt }))
      changed()
      emit('session', state.session)
      emit('resumed', meta)
    } catch (err) {
      flash(`resume failed: ${errorText(err, 80)}`)
    }
  }

  async function listProjects() {
    const metas = await listSessions({ scope: 'everywhere', root: boot.root })
    const byRoot = new Map()
    for (const m of metas) {
      const entry = byRoot.get(m.header.root)
      if (entry) {
        entry.sessions.push(m)
        entry.count++
        continue
      }
      byRoot.set(m.header.root, { root: m.header.root, latest: m, sessions: [m], count: 1, current: m.header.root === boot.root })
    }
    return [...byRoot.values()]
  }

  async function switchProject(meta) {
    if (state.busy) return flash('finish or interrupt the current turn first')
    try {
      const previousMcp = boot.mcp
      const next = await boot.rebuild(meta.header.root)
      previousMcp.closeAll().catch(() => {})
      process.chdir(next.cwd)
      Object.assign(boot, next)
      boot.git.retarget(next.root)
      next.mcp.connectAll()
      emit('mcp', next.mcp.list())
      set({ queued: [], expedited: [] })
      emit('project', boot)
      await resume(meta)
      flash(`switched to ${next.displayCwd}`)
    } catch (err) {
      flash(`switch failed: ${errorText(err, 80)}`)
    }
  }

  function resolveModel(name) {
    const exact = boot.models.find((m) => m.name === name)
    if (exact) return exact
    if (name.includes('/')) return adhocModel(name, boot.providers)
    const scored = boot.models
      .map((m) => [fuzzyScore(name, m.name), m])
      .filter(([score]) => score >= 0)
      .sort((a, b) => b[0] - a[0])
    return scored[0]?.[1] || null
  }

  function switchModel(pick, { asDefault = false, note = '' } = {}) {
    if (!pick) return false
    if (pick.available === false) {
      flash(`set ${pick.keyHint} in your environment to use ${pick.name}`)
      return false
    }
    persist(makeEvent('model_switch', { from: state.model.name, to: pick.name }))
    state.model = pick
    if (asDefault) {
      state.defaultModel = pick
      writeConfig({ defaultModel: pick.name }).catch(() => {})
    }
    changed()
    flash(`model set to ${pick.name}${note}${asDefault ? ' · saved as default' : ''}`)
    return true
  }

  function switchModelByName(name) {
    const pick = resolveModel(name)
    if (!pick) return flash(`no available model matches "${name}"`)
    const adhoc = !boot.models.includes(pick)
    switchModel(pick, { note: adhoc ? ' (not in catalog, pricing unknown)' : '' })
  }

  const effortApplies = () => !!state.model.effort

  function setEffort(next, { asDefault = false } = {}) {
    persist(makeEvent('effort', { to: next }))
    state.effort = next
    if (asDefault) {
      state.defaultEffort = next
      writeConfig({ defaultEffort: next }).catch(() => {})
    }
    changed()
    flash(`effort: ${next ?? 'default'}${asDefault ? ' · saved as default' : ''}`)
  }

  function setEffortByName(level) {
    if (!effortApplies()) return flash(`${state.model.name} does not support effort control`)
    if (level === 'default') return setEffort(null)
    if (!EFFORT_LEVELS.some((l) => l.key === level)) return flash('usage: /effort <default|low|medium|high|max>')
    setEffort(level)
  }

  function modelAvailable(name) {
    return !!name && boot.models.some((m) => m.name === name && m.available !== false)
  }

  function sendParallel(task) {
    if (!task) {
      flash('usage: /parallel <task>')
      return true
    }
    if (!modelAvailable(boot.researchModel)) return false
    nextResearchAgentLimit = boot.researchAgentLimit
    send(parallelPrompt(task, boot.researchAgentLimit))
    return true
  }

  function sendDeliberate(decision) {
    if (!decision) {
      flash('usage: /deliberate <decision>')
      return true
    }
    if (!modelAvailable(boot.deliberationModel)) return false
    send(deliberatePrompt(decision))
    return true
  }

  async function sendSkill(name) {
    const body = await boot.skills.load(name)
    if (!body) return flash(`could not load skill ${name}`)
    persist(makeEvent('skill', { name, source: 'user' }))
    send(`Follow these skill instructions now.\n\n${body}`)
  }

  async function sendCommand(name, args) {
    const text = await boot.commands.load(name, args)
    if (!text) return flash(`could not load command ${name}`)
    send(text)
  }

  function sendInit(args) {
    send(initPrompt(args))
  }

  function previewSteer(changes) {
    if (!changes?.length) return state.derived
    return deriveState([...state.events, { id: '__steer_preview__', at: Date.now(), type: 'steer', data: { changes } }])
  }

  function applySteer(changes) {
    if (!changes?.length) return
    persist(makeEvent('steer', { changes }))
    reDerive()
  }

  async function rewind(target, mode) {
    const current = state.derived
    const { edits } = rewindStats(current, target.index)
    const editsLabel = `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}`
    let reverted = []
    let skipped = []

    if (mode === 'both' || mode === 'code') {
      const result = await revertEdits(edits)
      reverted = result.reverted
      skipped = result.skipped
    }

    let summaryText = null
    if (mode === 'summary') {
      const tail = current.transcript.slice(target.index)
      const text = tail.filter((m) => m.text).map((m) => `${m.kind}: ${m.text}`).join('\n')
      flash('summarizing...')
      const { auth } = await codexAuth()
      summaryText = await summarizeText({ text, modelName: state.model.name, auth }).catch(() => {
        flash('summary model call failed · kept a crude digest of the rewound turns')
        return tail.filter((m) => m.text).slice(0, 3).map((m) => m.text.split(/\s+/).slice(0, 6).join(' ')).join(' · ')
      })
    }

    const event = makeEvent('rewind', { target: target.eventId, mode, summaryText, reverted, skipped })
    persist(event)
    state.rewindUndo = { rewindId: event.id, edits: edits.filter((e) => reverted.includes(e.callId)) }
    reDerive()
    if (mode !== 'code') emit('input', recallText(target))

    const skippedNote = skipped.length ? ` · skipped ${skipped.length} drifted` : ''
    if (mode === 'code') flash(`reverted ${editsLabel}, conversation kept${skippedNote} · ctrl+z to undo`)
    else if (mode === 'summary') flash(`rewound and summarized${skippedNote} · ctrl+z to undo`)
    else if (mode === 'both') flash(`rewound, ${editsLabel} reverted${skippedNote} · ctrl+z to undo`)
    else flash(`rewound, file changes kept · ctrl+z to undo`)
  }

  async function undoRewind() {
    const undo = state.rewindUndo
    if (!undo) return
    const { skipped } = await reapplyEdits(undo.edits)
    persist(makeEvent('rewind_undo', { rewindId: undo.rewindId }))
    state.rewindUndo = null
    reDerive()
    flash(skipped.length ? `rewind undone · ${skipped.length} file(s) drifted` : 'rewind undone')
  }

  function costSummary() {
    const current = state.derived
    const entries = Object.entries(current.usageByModel)
    if (entries.length === 0) return null
    const costOf = (byModel) =>
      Object.entries(byModel).reduce((sum, [name, usage]) => sum + estimateCost(findModel(boot.models, name), usage), 0)
    return {
      spent: costOf(current.usageByModel),
      active: costOf(current.usageActiveByModel),
      promptTokens: current.usage.promptTokens,
      completionTokens: current.usage.completionTokens,
    }
  }

  async function exportMarkdown(file = join(boot.cwd, `pico-export-${Date.now()}.md`)) {
    await writeFile(file, transcriptToMarkdown(state.derived.transcript, { title: `pico session · ${boot.cwd}` }))
    return file
  }

  function baseToolset(extra = {}) {
    return createToolset({
      cwd: boot.cwd,
      tracker: boot.tracker,
      skills: boot.skills,
      shells: boot.shells,
      wakeups: boot.wakeups,
      memory: boot.memory,
      dredge: boot.dredge,
      ...extra,
    })
  }

  async function describeTools() {
    const scan = await scanUserTools({ cwd: boot.cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
    const { tools: builtins } = baseToolset()
    return {
      mcpCount: boot.mcp.tools().length,
      rows: [
        ...builtins.map((t) => ({ name: t.name, desc: t.description.split('\n')[0], note: 'builtin' })),
        ...scan.tools.map((t) => ({ name: t.name, desc: t.description, note: `${t.source} · ${t._file.split('/').pop()}` })),
        ...scan.errors.map((e) => ({ name: e.file.split('/').pop(), desc: e.error, note: 'broken' })),
      ],
    }
  }

  async function contextBreakdown() {
    const est = (text) => Math.round(String(text).length / 4)
    const current = state.derived
    const memoryIndexText = memoryIndex(await boot.memory.list().catch(() => []), boot.root)
    const skillList = boot.skills.list()
    const files = boot.startupContext.files
    const systemFull = buildSystemPrompt({ cwd: boot.cwd, contextFiles: files, skills: skillList, memoryIndexText })
    const systemBase = buildSystemPrompt({ cwd: boot.cwd, contextFiles: [], skills: [], memoryIndexText: '' })
    const userToolScan = await scanUserTools({ cwd: boot.cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
    const { tools } = baseToolset({ mcpTools: boot.mcp.tools(), userTools: userToolScan.tools })
    const toolTokens = est(JSON.stringify(tools))

    const history = current.providerHistory
    const compacted = history[0]?.role === 'user'
      && current.historyEventIds[0] === null
      && String(history[0].content).startsWith('[system notification] The earlier portion')
    const summaryTokens = compacted ? est(history[0].content) : 0
    const messages = compacted ? history.slice(1) : history
    const messageTokens = est(JSON.stringify(messages))

    const rows = [
      { name: 'system prompt', desc: 'identity, environment, tool guidance', tokens: est(systemBase) },
      { name: `tool schemas (${tools.length})`, desc: tools.map((t) => t.name).join(' · '), tokens: toolTokens },
    ]
    if (files.length) {
      rows.push({
        name: `project instructions (${files.length})`,
        desc: files.map((f) => f.path.replace(`${boot.root}/`, '')).join(', '),
        tokens: files.reduce((sum, f) => sum + est(f.content), 0),
      })
    }
    if (skillList.length) {
      rows.push({
        name: `skills index (${skillList.length})`,
        desc: skillList.map((s) => s.name).join(', '),
        tokens: est(skillList.map((s) => `- ${s.name}: ${s.description}`).join('\n')),
      })
    }
    if (memoryIndexText) rows.push({ name: 'memory index', desc: 'one line per saved memory', tokens: est(memoryIndexText) })
    if (compacted) rows.push({ name: 'compaction summary', desc: 'stands in for everything before the last compact', tokens: summaryTokens })
    rows.push({
      name: `conversation (${messages.length} messages)`,
      desc: compacted ? 'kept verbatim since the last compact' : 'every message this session',
      tokens: messageTokens,
    })

    const measured = current.lastPromptTokens && current.lastPromptModel === state.model.name ? current.lastPromptTokens : null

    const segments = [
      { label: 'system', tokens: est(systemBase) },
      { label: 'tools', tokens: toolTokens },
      { label: 'project', tokens: Math.max(0, est(systemFull) - est(systemBase)) },
      ...(summaryTokens ? [{ label: 'summary', tokens: summaryTokens }] : []),
      { label: 'conversation', tokens: messageTokens },
    ].filter((segment) => segment.tokens > 0)
      .map((segment, i) => ({ ...segment, color: CONTEXT_COLORS[i] }))

    return { model: state.model.name, rows, measured, segments }
  }

  async function connectProvider() {
    const { email } = await connectOpenAI()
    boot.providers = [...new Set([...boot.providers, 'codex'])]
    const creds = await openaiCredentials().catch(() => null)
    const codex = (await loadCodexModels(creds)).map((m) => ({ ...m, available: true, keyHint: '/connect' }))
    boot.models = [...boot.models.filter((m) => m.provider !== 'codex'), ...codex]
    reDerive()
    return { email, count: codex.length }
  }

  async function disconnectProvider() {
    await disconnectOpenAI().catch(() => {})
    boot.providers = boot.providers.filter((p) => p !== 'codex')
    boot.models = boot.models.map((m) => (m.provider === 'codex' ? { ...m, available: false } : m))
    if (state.model.provider === 'codex') state.model = state.defaultModel
    changed()
  }

  function activity() {
    const rows = [...agents.list(), ...deliberationsFromEvents(state.events)]
    return rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  }

  function cancelAgent(id) {
    agents.cancel(id)
  }

  function dismissAgent(id) {
    if (!agents.dismiss(id)) return false
    persist(makeEvent('agent_dismiss', { agentId: id }))
    return true
  }

  function dismissDeliberation(deliberationId) {
    persist(makeEvent('deliberation_dismiss', { deliberationId }))
    bumpActivity()
  }

  function shellRows() {
    return boot.shells.list()
      .filter((shell) => shell.sessionId === state.session?.id)
      .sort((a, b) => Number(b.id) - Number(a.id))
  }

  function cancelWakeup(wakeup) {
    boot.wakeups.cancel(wakeup.id)
    flash(`cancelled wake-up ${wakeup.id}`)
    noteSystem(
      `[system notification] the user cancelled scheduled wake-up ${wakeup.id} (note was: ${wakeup.note.replace(/\n/g, ' ')}). This was deliberate; do not reschedule it unless asked.`,
      { wake: false },
    )
  }

  async function shutdown() {
    await state.session?.flush()
    boot.shells.killAll()
    boot.mcp.terminateAll()
  }

  return {
    state,
    boot,
    on,
    agents,
    send,
    interrupt,
    compact,
    answerQuestion,
    cancelQuestion,
    recallPending,
    expediteQueued,
    hold,
    noteSystem,
    newSession,
    deleteCurrentSession,
    fork,
    rename,
    setColor,
    clear,
    resume,
    listProjects,
    switchProject,
    resolveModel,
    switchModel,
    switchModelByName,
    effortApplies,
    setEffort,
    setEffortByName,
    sendParallel,
    sendDeliberate,
    sendSkill,
    sendCommand,
    sendInit,
    previewSteer,
    applySteer,
    rewind,
    undoRewind,
    recallText,
    attachImage,
    attachProjectFile,
    detachImage,
    costSummary,
    exportMarkdown,
    describeTools,
    contextBreakdown,
    connectProvider,
    disconnectProvider,
    activity,
    cancelAgent,
    dismissAgent,
    dismissDeliberation,
    shellRows,
    cancelWakeup,
    shutdown,
  }
}
