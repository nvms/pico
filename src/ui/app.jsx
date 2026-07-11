import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSignal, Menu, ProgressBar, ScrollBox, Shimmer, TextArea, useFocus, useFocusTrap, useFrameStats, useInput, useSelection, useToast } from '@trendr/core'
import { makeEvent } from '../core/events.js'
import { createSession, openSession, loadSession, listSessions, deleteSession, deleteProjectData } from '../core/session.js'
import { deriveState, userEntries, rewindStats } from '../core/derive.js'
import { appendPrompt, loadProjectPrompts, loadGlobalPrompts } from '../core/history.js'
import { runTurn, summarizeText, compactHistory, compactProgress } from '../core/agent.js'
import { compactionPrompt, formatCompactSummary, summarySections } from '../core/compaction.js'
import { createToolset } from '../core/tools/index.js'
import { scanUserTools } from '../core/user-tools.js'
import { createSkillIndex } from '../core/skills.js'
import { createCommandIndex } from '../core/commands.js'
import { revertEdits, reapplyEdits } from '../core/rewind.js'
import { buildSystemPrompt } from '../core/system-prompt.js'
import { checkForUpdate, fetchLatestVersion, newerVersion, isDevInstall, runUpdate } from '../core/update.js'
import { memoryIndex } from '../core/memory.js'
import { transcriptToMarkdown } from '../core/export.js'
import { findModel, estimateCost } from '../core/models.js'
import { adhocModel } from '../core/catalog.js'
import { writeConfig } from '../core/config.js'
import { connectOpenAI, openaiCredentials, openaiStatus, disconnectOpenAI } from '../core/openai-auth.js'
import { loadCodexModels } from '../core/codex-models.js'
import { fuzzyScore } from './fuzzy.js'
import { completionContext, applyCompletion } from './completion.js'
import { extractImagePaths, mediaTypeFor, finalizeUserContent, placeholderizeImagePaths, inputTextFromContent } from './attachments.js'
import { listFiles } from './files.js'
import { highlightVersion } from './highlight.js'
import { Message, Banner, uiTitle } from './transcript.jsx'
import { Help } from './help.jsx'
import { ModelPanel, EffortPanel, ThemePanel, HistoryPanel, RewindPickPanel, RewindActionPanel, ResumePanel, ProjectPanel, McpPanel, MemoryPanel, InfoListPanel, ShellsPanel, WakeupsPanel, ConnectPanel, timeAgo } from './panels.jsx'
import { accent, setAccent, setPalette, paletteName, paletteList, DEFAULT_ACCENT, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, RED, HIGHLIGHT } from './theme.js'

const EFFORT_LEVELS = [
  { key: null, desc: 'let the provider decide how much to think' },
  { key: 'low', desc: 'quick answers, minimal thinking' },
  { key: 'medium', desc: 'moderate thinking budget' },
  { key: 'high', desc: 'generous thinking budget' },
  { key: 'max', desc: 'maximum thinking budget' },
]

const COMMANDS = [
  { name: 'model', desc: 'Switch the active model for this session' },
  { name: 'connect', desc: 'Sign in with ChatGPT to use a Codex subscription' },
  { name: 'effort', desc: 'Set the thinking effort for this session' },
  { name: 'resume', desc: 'Pick up a previous session where you left off' },
  { name: 'new', desc: 'Start a new session in this project' },
  { name: 'project', desc: 'Switch projects: jump to another project, same as ctrl+p' },
  { name: 'cwd', desc: 'Show the current working directory and project root' },
  { name: 'skills', desc: 'List every skill: builtin, global, and project' },
  { name: 'commands', desc: 'List every command: builtin, global, and project' },
  { name: 'tools', desc: 'List builtin and user-defined tools; MCP tools live in /mcp' },
  { name: 'rewind', desc: 'Restore the conversation to a previous message' },
  { name: 'rename', desc: 'Name this session: /rename <name>' },
  { name: 'color', desc: 'Color this session: /color <name or #hex>' },
  { name: 'theme', desc: 'Pick a color theme; /theme <name> applies one directly' },
  { name: 'mcp', desc: 'Manage MCP servers: add, toggle, reconnect' },
  { name: 'shells', desc: 'View and manage background shells' },
  { name: 'wakeups', desc: 'View and cancel scheduled wake-ups' },
  { name: 'memory', desc: 'Browse and manage saved memories: project and global' },
  { name: 'compact', desc: 'Summarize the conversation to free the context window' },
  { name: 'clear', desc: 'Clear the conversation and free the context window' },
  { name: 'cost', desc: 'Show token usage and estimated cost so far' },
  { name: 'context', desc: "Show what's in the model's context and how big each piece is" },
  { name: 'export', desc: 'Save the current conversation to a markdown file' },
  { name: 'update', desc: 'Update pico to the latest release from npm' },
  { name: 'help', desc: 'List every command and what it does' },
]

const SESSION_COLORS = {
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

const HISTORY_SCOPES = ['session', 'project', 'everywhere']
const MEMORY_SCOPES = ['all', 'project', 'global']
const SHELL_STRIP_MAX = 5

// only the newest slice of a long transcript renders; older items load in
// batches when the user scrolls to the top. render cost is per-item, so this
// keeps day-long sessions as fast as fresh ones
const HISTORY_WINDOW = 50
const RESUME_SCOPES = ['project', 'everywhere']

export function App({ boot }) {
  const { cwd, root, version, models, skills, mcp, tracker, startupContext } = boot

  const [derived, setDerived] = createSignal(deriveState([]))
  const [overlay, setOverlay] = createSignal([])
  const [streaming, setStreaming] = createSignal(null)
  const [thinkingNow, setThinkingNow] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [compacting, setCompacting] = createSignal(false)
  const [compactStatus, setCompactStatus] = createSignal(null)
  const [startedAt, setStartedAt] = createSignal(0)
  const [input, setInput] = createSignal('')
  const [model, setModel] = createSignal(boot.initialModel)
  const [defaultModel, setDefaultModel] = createSignal(boot.initialModel)
  const [effort, setEffort] = createSignal(boot.initialEffort)
  const [defaultEffort, setDefaultEffort] = createSignal(boot.initialEffort)
  const [showEffortPanel, setShowEffortPanel] = createSignal(false)
  const [showThemePanel, setShowThemePanel] = createSignal(false)
  const [showMemoryPanel, setShowMemoryPanel] = createSignal(false)
  const [memScope, setMemScope] = createSignal(0)
  const [memoryList, setMemoryList] = createSignal([])
  const [themePref, setThemePref] = createSignal(boot.themePref || 'auto')
  const [queued, setQueued] = createSignal([])
  const [sent, setSent] = createSignal([])
  const [histIdx, setHistIdx] = createSignal(-1)
  const [cmdIndex, setCmdIndex] = createSignal(0)
  const [cmdCycle, setCmdCycle] = createSignal(null)
  const [fileIndex, setFileIndex] = createSignal(0)
  const [fileList, setFileList] = createSignal([])
  const [filesDismissed, setFilesDismissed] = createSignal(false)
  const [view, setView] = createSignal('chat')
  const [verbose, setVerbose] = createSignal(false)
  const [showModelPanel, setShowModelPanel] = createSignal(false)
  const [showHistoryPanel, setShowHistoryPanel] = createSignal(false)
  const [histScope, setHistScope] = createSignal(0)
  const [histPrompts, setHistPrompts] = createSignal([])
  const [showResumePanel, setShowResumePanel] = createSignal(false)
  const [resumeScope, setResumeScope] = createSignal(0)
  const [resumeSessions, setResumeSessions] = createSignal([])
  const [resumeLoading, setResumeLoading] = createSignal(false)
  const [showMcpPanel, setShowMcpPanel] = createSignal(false)
  const [showProjectPanel, setShowProjectPanel] = createSignal(false)
  const [infoPanel, setInfoPanel] = createSignal(null)
  const [showShellsPanel, setShowShellsPanel] = createSignal(false)
  const [showWakeupsPanel, setShowWakeupsPanel] = createSignal(false)
  const [showConnectPanel, setShowConnectPanel] = createSignal(false)
  const [authProviders, setAuthProviders] = createSignal([])
  const [shellsVersion, setShellsVersion] = createSignal(0)
  const [projects, setProjects] = createSignal([])
  const [projectsLoading, setProjectsLoading] = createSignal(false)
  const [mcpServers, setMcpServers] = createSignal(mcp.list())
  const [completing, setCompleting] = createSignal(false)
  const [compIndex, setCompIndex] = createSignal(0)
  const [rewindStep, setRewindStep] = createSignal(null)
  const [rewindTarget, setRewindTarget] = createSignal(null)
  const [offset, setOffset] = createSignal(0)
  const [follow, setFollow] = createSignal(true)
  const [histWindow, setHistWindow] = createSignal(HISTORY_WINDOW)

  const refs = boot.refs
  refs.session ??= null
  refs.allEvents ??= []
  refs.persisted ??= 0
  refs.abort = refs.abort || null
  refs.rewindUndo = refs.rewindUndo || null
  refs.quitAt ??= 0
  refs.attachments ??= new Map()
  refs.imageCount ??= 0

  boot.setMcpNotify(() => setMcpServers(boot.mcp.list()))
  boot.setShellsNotify(() => setShellsVersion((v) => v + 1))
  boot.setWakeupsNotify(() => setShellsVersion((v) => v + 1))
  boot.setWakeupsFire((wakeup) => {
    flash(`wake-up ${wakeup.id} fired`)
    noteSystem(
      `[system notification] scheduled wake-up ${wakeup.id} fired. Note to self: ${wakeup.note}`,
      { wake: true },
    )
  })
  boot.setShellsExit((shell) => {
    if (shell.killedBy === 'model') {
      flash(`shell ${shell.id} killed`)
      return
    }
    if (shell.killedBy === 'user') {
      flash(`shell ${shell.id} killed`)
      noteSystem(`[system notification] the user manually killed background shell ${shell.id} (${shell.description || shell.command}) from the shells panel (SIGTERM). This was deliberate; do not restart it unless asked.`, { wake: false })
      return
    }
    flash(`shell ${shell.id} exited · code ${shell.exitCode}`)
    const tail = boot.shells.output(shell.id, { tail: 30 }).output
    const secs = Math.max(0, Math.round(((shell.endedAt || Date.now()) - shell.startedAt) / 1000))
    const ran = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
    noteSystem(
      `[system notification] background shell ${shell.id} (${shell.description || shell.command}) exited with code ${shell.exitCode} after ${ran}.` +
        (tail ? `\nRecent output:\n${tail}` : ''),
      { wake: true },
    )
  })

  function noteSystem(text, { wake }) {
    refs.pendingSystemNotes ??= []
    refs.pendingSystemNotes.push({ text, wake })
    flushSystemNotes()
  }

  function flushSystemNotes() {
    if (!refs.pendingSystemNotes?.length || busy() || view() !== 'chat' || !refs.session) return
    const notes = refs.pendingSystemNotes
    refs.pendingSystemNotes = []
    persist(makeEvent('system_note', { text: notes.map((n) => n.text).join('\n\n') }))
    reDerive()
    if (notes.some((n) => n.wake)) runAgentTurn()
  }

  const skillCommands = skills.list().map((s) => ({ name: s.name, desc: `skill · ${s.description || s.source}`, skill: true }))
  const userCommands = boot.commands.list().map((c) => ({ name: c.name, desc: `command · ${c.description || c.source}`, command: true }))
  const byName = new Map()
  const shadowed = []
  for (const c of [...COMMANDS, ...skillCommands, ...userCommands]) {
    if (byName.has(c.name)) shadowed.push(`${c.skill ? 'skill' : 'command'} "${c.name}"`)
    else byName.set(c.name, c)
  }
  const allCommands = [...byName.values()]
  if (shadowed.length && !refs.warnedShadowed) {
    refs.warnedShadowed = true
    setTimeout(() => flash(`shadowed by an earlier name, rename to use: ${shadowed.join(', ')}`), 0)
  }

  const toast = useToast({
    duration: 3500,
    position: 'top-right',
    render: (message) => <text style={{ bg: accent(), color: 'black', bold: true }}>{` ${message} `}</text>,
  })

  const updateToast = useToast({
    duration: 8000,
    position: 'top-center',
    render: (message) => (
      <box style={{ bg: accent() }}>
        <Shimmer color="black" highlight={HIGHLIGHT} duration={1500}>{` ${message} `}</Shimmer>
      </box>
    ),
  })

  function flash(msg) {
    toast(msg)
  }

  if (!refs.updateChecked) {
    refs.updateChecked = true
    checkForUpdate(version).then((found) => {
      if (!found) return
      updateToast(`pico v${found.version} available · /update`)
      found.markNotified()
    }).catch(() => {})
  }

  function ensureSession() {
    if (!refs.session) refs.session = createSession({ cwd, root })
    while (refs.persisted < refs.allEvents.length) {
      refs.session.append(refs.allEvents[refs.persisted])
      refs.persisted++
    }
  }

  function persist(event) {
    refs.allEvents.push(event)
    if (refs.session) {
      refs.session.append(event)
      refs.persisted = refs.allEvents.length
    }
  }

  function reDerive() {
    const state = deriveState(refs.allEvents)
    setDerived(state)
    setAccent(state.color)
    boot.setTheme?.({ accent: state.color || DEFAULT_ACCENT, muted: MUTED })
  }

  function flushStream(items) {
    const text = streaming()
    if (text) items.push({ kind: 'assistant', text })
    setStreaming(null)
  }

  async function executeTurn(text) {
    const { content } = finalizeUserContent(text, refs.attachments)
    persist(makeEvent('message', { message: { role: 'user', content } }))
    ensureSession()
    reDerive()
    await runAgentTurn()
  }

  async function performCompaction(instructions = '') {
    if (busy() || compacting()) return flash('finish or interrupt the current turn first')
    const state = derived()
    if (state.providerHistory.length < 4) return flash('nothing to compact yet')

    let auth = null
    if (model().provider === 'codex') {
      auth = await openaiCredentials().catch(() => null)
      if (!auth) return flash('codex models need a ChatGPT sign-in: run /connect')
    }

    const entries = userEntries(state)
    const keepFrom = entries.at(-2)?.eventId ?? entries.at(-1)?.eventId

    const controller = new AbortController()
    refs.abort = controller
    setBusy(true)
    setCompacting(true)
    setCompactStatus(null)
    setStartedAt(Date.now())
    let streamed = ''
    try {
      const raw = await compactHistory({
        history: state.providerHistory,
        modelName: model().name,
        auth,
        prompt: compactionPrompt(instructions),
        signal: controller.signal,
        onStream: (event) => {
          if (event.type !== 'content') return
          streamed += event.content
          setCompactStatus(compactProgress(streamed))
        },
      })
      const summary = formatCompactSummary(raw)
      if (!summary) throw new Error('empty summary')
      if (summarySections(summary) < 5) throw new Error('malformed summary, conversation left untouched')
      persist(makeEvent('compact', { summary, keepFrom, sessionFile: refs.session?.file || null }))
      reDerive()
      flash('compacted · recent messages kept verbatim')
    } catch (err) {
      if (controller.signal.aborted) flash('compaction cancelled')
      else flash(`compact failed: ${String(err.message || err).slice(0, 100)}`)
    } finally {
      setCompacting(false)
      setCompactStatus(null)
      setBusy(false)
      refs.abort = null
    }

    const q = queued()
    if (q.length > 0) {
      setQueued([])
      if (controller.signal.aborted) setInput(q.join('\n'))
      else executeTurn(q.join('\n'))
    }
  }

  function maybeAutoCompact() {
    if (boot.autoCompact === false || busy() || compacting()) return
    const limit = model().context
    const used = derived().lastPromptTokens
    if (!limit || !used || derived().lastPromptModel !== model().name) return
    const ratio = used / limit
    if (ratio >= 0.85) {
      flash(`context ${Math.round(ratio * 100)}% full · auto-compacting`)
      performCompaction()
    }
  }

  async function runAgentTurn() {
    let auth = null
    if (model().provider === 'codex') {
      auth = await openaiCredentials().catch(() => null)
      if (!auth) {
        flash('codex models need a ChatGPT sign-in: run /connect')
        return
      }
    }
    setFollow(true)
    setHistWindow(HISTORY_WINDOW)
    setBusy(true)
    setStartedAt(Date.now())

    const controller = new AbortController()
    refs.abort = controller
    const loadedBefore = new Set(tracker.loaded)
    boot.skills = await createSkillIndex(boot.root).catch(() => boot.skills) ?? boot.skills
    boot.commands = await createCommandIndex(boot.root).catch(() => boot.commands) ?? boot.commands
    const freshSkills = boot.skills
    const userToolScan = await scanUserTools({ cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
    for (const failure of userToolScan.errors) {
      const key = `${failure.file}:${failure.error}`
      if (!refs.warnedTools?.has(key)) {
        ;(refs.warnedTools ??= new Set()).add(key)
        flash(`tool skipped: ${failure.file.split('/').pop()} · ${failure.error}`)
      }
    }
    const { tools, recorder } = createToolset({
      cwd,
      tracker,
      skills: freshSkills,
      shells: boot.shells,
      wakeups: boot.wakeups,
      memory: boot.memory,
      dredge: boot.dredge,
      mcpTools: mcp.tools(),
      userTools: userToolScan.tools,
      signal: controller.signal,
    })

    refs.turnThoughts = ''
    const onStream = (event) => {
      if (event.type === 'thinking') {
        refs.turnThoughts += event.content
        setThinkingNow(true)
      } else if (event.type === 'content') {
        setThinkingNow(false)
        setStreaming((s) => (s || '') + event.content)
      } else if (event.type === 'tool_calls_ready') {
        setThinkingNow(false)
        setOverlay((o) => {
          const next = [...o]
          flushStream(next)
          return next
        })
      } else if (event.type === 'tool_executing') {
        setOverlay((o) => {
          const next = [...o]
          flushStream(next)
          let args = {}
          try {
            args = JSON.parse(event.call.function.arguments)
          } catch {}
          next.push({
            kind: 'tool',
            callId: event.call.id,
            name: event.call.function.name,
            title: uiTitle(event.call.function.name, args),
            status: 'running',
          })
          return next
        })
      } else if (event.type === 'tool_complete' || event.type === 'tool_error') {
        const entry = recorder.entries.at(-1)
        setOverlay((o) =>
          o.map((item) =>
            item.kind === 'tool' && item.callId === event.call.id
              ? { ...item, ...(entry?.callId === event.call.id ? entry : {}), kind: 'tool', status: entry?.status || 'done' }
              : item,
          ),
        )
      }
    }

    let result
    try {
      result = await runTurn({
        history: derived().providerHistory,
        tools,
        recorder,
        modelName: model().name,
        effort: effortApplies() ? effort() ?? 'auto' : null,
        auth,
        system: buildSystemPrompt({
          cwd,
          contextFiles: startupContext.files,
          skills: freshSkills.list(),
          memoryIndexText: memoryIndex(await boot.memory.list().catch(() => []), boot.root),
        }),
        signal: controller.signal,
        onStream,
      })
    } catch (err) {
      setOverlay([])
      setStreaming(null)
      setThinkingNow(false)
      setBusy(false)
      refs.abort = null
      flash(`error: ${String(err.message || err).slice(0, 120)}`)
      return
    }

    if (refs.turnThoughts) persist(makeEvent('thoughts', { text: refs.turnThoughts }))
    for (const message of result.messages) persist(makeEvent('message', { message }))
    for (const entry of recorder.entries) persist(makeEvent('tool_meta', entry))
    for (const path of tracker.loaded) {
      if (!loadedBefore.has(path)) persist(makeEvent('context_file', { path }))
    }
    if (result.usage) persist(makeEvent('usage', { model: model().name, usage: result.usage, lastPrompt: result.lastPromptTokens }))
    if (result.interrupted) persist(makeEvent('interrupt', {}))

    setOverlay([])
    setStreaming(null)
    setThinkingNow(false)
    reDerive()
    setBusy(false)
    refs.abort = null
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

    const q = queued()
    if (q.length > 0) {
      setQueued([])
      if (result.interrupted) setInput(q.join('\n'))
      else {
        executeTurn(q.join('\n'))
        return
      }
    }
    flushSystemNotes()
    maybeAutoCompact()
  }

  function completionSource(name) {
    if (name === 'color') return Object.keys(SESSION_COLORS)
    if (name === 'theme') return [...paletteList().map((p) => p.key), 'auto']
    if (name === 'effort') return ['default', 'low', 'medium', 'high', 'max']
    if (name === 'model') return models.filter((m) => m.available !== false).map((m) => m.name)
    const cmd = allCommands.find((c) => c.name === name)
    if (cmd?.skill || cmd?.command) return fileList()
    return null
  }

  function dismissCompletion() {
    setCompleting(false)
    setCompIndex(0)
  }

  function acceptCompletion(value, ctx, candidate) {
    setInput(applyCompletion(value, ctx, candidate))
    dismissCompletion()
  }

  function send(text) {
    const value = text.trim()
    if (!value) return
    dismissCompletion()
    if (value.startsWith('/')) {
      const [name, ...rest] = value.slice(1).split(/\s+/)
      const match = allCommands.find((c) => c.name === name.toLowerCase())
      if (match) {
        setInput('')
        runCommand(match, rest.join(' '))
        return
      }
    }
    setSent((s) => [...s, { text: value, at: Date.now() }])
    setHistIdx(-1)
    appendPrompt(root, value).catch(() => {})
    if (busy()) {
      setQueued((q) => [...q, value])
      return
    }
    executeTurn(value)
  }

  function interrupt() {
    if (!busy()) return
    refs.abort?.abort()
  }

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  async function refreshMemories() {
    setMemoryList(await boot.memory.list().catch(() => []))
  }

  async function forgetMemory(m) {
    const armed = refs.forgetArm
    if (!armed || armed.file !== m.file || Date.now() - armed.at > 3000) {
      refs.forgetArm = { file: m.file, at: Date.now() }
      return flash(`ctrl+x again to forget "${m.name}"`)
    }
    refs.forgetArm = null
    try {
      await boot.memory.forget(m.name)
      await refreshMemories()
      flash(`forgot ${m.name} (${m.scope})`)
    } catch (err) {
      flash(`forget failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function openContextPanel() {
    const est = (text) => Math.round(String(text).length / 4)
    const tok = (n) => `~${fmtTokens(n)} tok`
    const state = derived()

    const memoryIndexText = memoryIndex(await boot.memory.list().catch(() => []), boot.root)
    const skillList = boot.skills.list()
    const files = startupContext.files
    const systemFull = buildSystemPrompt({ cwd, contextFiles: files, skills: skillList, memoryIndexText })
    const systemBase = buildSystemPrompt({ cwd, contextFiles: [], skills: [], memoryIndexText: '' })
    const userToolScan = await scanUserTools({ cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
    const { tools } = createToolset({
      cwd,
      tracker,
      skills: boot.skills,
      shells: boot.shells,
      wakeups: boot.wakeups,
      memory: boot.memory,
      dredge: boot.dredge,
      mcpTools: mcp.tools(),
      userTools: userToolScan.tools,
    })
    const toolTokens = est(JSON.stringify(tools))

    const history = state.providerHistory
    const compacted = history[0]?.role === 'user'
      && state.historyEventIds[0] === null
      && String(history[0].content).startsWith('[system notification] The earlier portion')
    const summaryTokens = compacted ? est(history[0].content) : 0
    const messages = compacted ? history.slice(1) : history
    const messageTokens = est(JSON.stringify(messages))

    const rows = [
      { name: 'system prompt', desc: 'identity, environment, tool guidance', note: tok(est(systemBase)) },
      { name: `tool schemas (${tools.length})`, desc: tools.map((t) => t.name).join(' · '), note: tok(toolTokens) },
    ]
    if (files.length) {
      rows.push({
        name: `project instructions (${files.length})`,
        desc: files.map((f) => f.path.replace(`${boot.root}/`, '')).join(', '),
        note: tok(files.reduce((sum, f) => sum + est(f.content), 0)),
      })
    }
    if (skillList.length) {
      rows.push({
        name: `skills index (${skillList.length})`,
        desc: skillList.map((s) => s.name).join(', '),
        note: tok(est(skillList.map((s) => `- ${s.name}: ${s.description}`).join('\n'))),
      })
    }
    if (memoryIndexText) {
      rows.push({ name: 'memory index', desc: 'one line per saved memory', note: tok(est(memoryIndexText)) })
    }
    if (compacted) {
      rows.push({ name: 'compaction summary', desc: 'stands in for everything before the last compact', note: tok(summaryTokens) })
    }
    rows.push({
      name: `conversation (${messages.length} messages)`,
      desc: compacted ? 'kept verbatim since the last compact' : 'every message this session',
      note: tok(messageTokens),
    })

    const total = est(systemFull) + toolTokens + summaryTokens + messageTokens
    const limit = model().context
    rows.push({
      name: 'estimated next request',
      desc: limit ? `of ${fmtTokens(limit)} context · ~${Math.round((total / limit) * 100)}%` : 'context size unknown for this model',
      note: tok(total),
    })
    if (state.lastPromptTokens && state.lastPromptModel === model().name) {
      rows.push({
        name: 'last measured request',
        desc: 'provider-reported input tokens, the number behind ctx %',
        note: `${state.lastPromptTokens.toLocaleString()} tok`,
      })
    }

    setInfoPanel({ title: `Context · ${model().name}`, rows })
  }

  const themeItems = () => [
    ...paletteList(),
    { key: 'auto', desc: `follow the terminal (detected: ${boot.detectedTheme || 'dark'})` },
  ]

  function paletteFor(pref) {
    return pref === 'auto' ? boot.detectedTheme || 'dark' : pref
  }

  function previewPalette(pref) {
    setPalette(paletteFor(pref))
    boot.setTheme?.({ accent: accent(), muted: MUTED })
  }

  function applyThemePref(pref) {
    setThemePref(pref)
    previewPalette(pref)
    writeConfig({ theme: pref === 'auto' ? undefined : pref }).catch(() => {})
    flash(pref === 'auto' ? `theme: auto · following the terminal (${paletteFor('auto')})` : `theme: ${pref}`)
  }

  async function runCommand(c, args = '') {
    if (typeof args !== 'string') args = ''
    setInput('')
    setCmdCycle(null)
    if (c.name === 'rename') {
      if (!args) return flash('usage: /rename <new name>')
      persist(makeEvent('title', { text: args }))
      ensureSession()
      reDerive()
      flash(`session renamed to "${args}"`)
      return
    }
    if (c.name === 'color') {
      const names = Object.keys(SESSION_COLORS)
      const values = Object.values(SESSION_COLORS)
      let value
      if (!args) {
        const next = (values.indexOf(derived().color) + 1) % values.length
        value = values[next]
      } else {
        value = SESSION_COLORS[args.toLowerCase()] || (/^#[0-9a-fA-F]{6}$/.test(args) ? args : null)
        if (!value) return flash(`usage: /color to cycle, or /color <${names.join('|')}|#hex>`)
      }
      persist(makeEvent('color', { value }))
      ensureSession()
      reDerive()
      const name = names[values.indexOf(value)]
      flash(`session color: ${name || value}`)
      return
    }
    if (c.name === 'theme') {
      if (!args) return setShowThemePanel(true)
      const choice = args.toLowerCase()
      const valid = [...paletteList().map((p) => p.key), 'auto']
      if (!valid.includes(choice)) return flash(`theme: ${paletteName()} · /theme <${valid.join('|')}>`)
      applyThemePref(choice)
      return
    }
    if (c.skill) {
      const body = await skills.load(c.name)
      if (!body) return flash(`could not load skill ${c.name}`)
      persist(makeEvent('skill', { name: c.name, source: 'user' }))
      send(`Follow these skill instructions now.\n\n${body}`)
      return
    }
    if (c.command) {
      const text = await boot.commands.load(c.name, args)
      if (!text) return flash(`could not load command ${c.name}`)
      send(text)
      return
    }
    if (c.name === 'connect') return openConnectPanel()
    if (c.name === 'model') {
      if (!args) return setShowModelPanel(true)
      const exact = models.find((m) => m.name === args)
      const adhoc = !exact && args.includes('/') ? adhocModel(args, boot.providers) : null
      const scored = exact || adhoc
        ? []
        : models
            .map((m) => [fuzzyScore(args, m.name), m])
            .filter(([score]) => score >= 0)
            .sort((a, b) => b[0] - a[0])
      const pick = exact || adhoc || scored[0]?.[1]
      if (!pick) return flash(`no available model matches "${args}"`)
      if (pick.available === false) return flash(`set ${pick.keyHint} in your environment to use ${pick.name}`)
      persist(makeEvent('model_switch', { from: model().name, to: pick.name }))
      setModel(pick)
      flash(adhoc ? `model set to ${pick.name} (not in catalog, pricing unknown)` : `model set to ${pick.name}`)
      return
    }
    if (c.name === 'effort') {
      if (!effortApplies()) return flash(`${model().name} does not support effort control`)
      if (!args) return setShowEffortPanel(true)
      const level = args.toLowerCase()
      if (level === 'default') return setSessionEffort(null)
      if (!EFFORT_LEVELS.some((l) => l.key === level)) return flash('usage: /effort <default|low|medium|high|max>')
      return setSessionEffort(level)
    }
    if (c.name === 'update') {
      if (isDevInstall(import.meta.url)) return flash('this pico runs from a source checkout · update it with git')
      const latest = await fetchLatestVersion().catch(() => null)
      if (latest && !newerVersion(version, latest)) return flash(`pico v${version} is already the latest`)
      flash(`updating${latest ? ` to v${latest}` : ''}...`)
      const result = await runUpdate()
      if (result.ok) return flash(`updated${latest ? ` to v${latest}` : ''} · restart pico to use it`)
      return flash(`update failed: ${result.output.slice(0, 100)}`)
    }
    if (c.name === 'context') return openContextPanel()
    if (c.name === 'help') return setView('help')
    if (c.name === 'mcp') return setShowMcpPanel(true)
    if (c.name === 'shells') return setShowShellsPanel(true)
    if (c.name === 'wakeups') return setShowWakeupsPanel(true)
    if (c.name === 'memory') {
      await refreshMemories()
      return setShowMemoryPanel(true)
    }
    if (c.name === 'resume') {
      setShowResumePanel(true)
      refreshSessions(resumeScope())
      return
    }
    if (c.name === 'project') return openProjectPanel()
    if (c.name === 'cwd') {
      const rootNote = boot.root !== boot.cwd ? ` · project root ${shortenPath(boot.root)}` : ''
      return flash(`${boot.displayCwd}${rootNote}`)
    }
    if (c.name === 'skills') {
      return setInfoPanel({
        title: 'Skills',
        rows: skills.list().map((s) => ({ name: s.name, desc: s.description, note: s.source })),
      })
    }
    if (c.name === 'commands') {
      return setInfoPanel({
        title: 'Commands',
        rows: [
          ...COMMANDS.map((cmd) => ({ name: `/${cmd.name}`, desc: cmd.desc, note: 'builtin' })),
          ...boot.commands.list().map((cmd) => ({ name: `/${cmd.name}`, desc: cmd.description, note: cmd.source })),
        ],
      })
    }
    if (c.name === 'tools') {
      const scan = await scanUserTools({ cwd: boot.cwd, root: boot.root }).catch(() => ({ tools: [], errors: [] }))
      const { tools: builtins } = createToolset({
        cwd: boot.cwd,
        tracker,
        skills,
        shells: boot.shells,
        wakeups: boot.wakeups,
        memory: boot.memory,
        dredge: boot.dredge,
      })
      const mcpCount = mcp.tools().length
      setInfoPanel({
        title: `Tools${mcpCount ? ` · plus ${mcpCount} MCP (see /mcp)` : ''}`,
        rows: [
          ...builtins.map((t) => ({ name: t.name, desc: t.description.split('\n')[0], note: 'builtin' })),
          ...scan.tools.map((t) => ({ name: t.name, desc: t.description, note: `${t.source} · ${t._file.split('/').pop()}` })),
          ...scan.errors.map((e) => ({ name: e.file.split('/').pop(), desc: e.error, note: 'broken' })),
        ],
      })
      return
    }
    if (c.name === 'new') {
      if (busy()) return flash('finish or interrupt the current turn first')
      refs.session = null
      refs.allEvents = []
      refs.persisted = 0
      refs.rewindUndo = null
      setQueued([])
      setSent([])
      setModel(defaultModel())
      setEffort(defaultEffort())
      setHistWindow(HISTORY_WINDOW)
      reDerive()
      flash('new session')
      return
    }
    if (c.name === 'rewind') {
      if (busy()) return flash('finish or interrupt the current turn first')
      if (userEntries(derived()).length === 0) return flash('nothing to rewind yet')
      setRewindStep('pick')
      return
    }
    if (c.name === 'clear') {
      if (busy()) return flash('finish or interrupt the current turn first')
      persist(makeEvent('clear', {}))
      reDerive()
      flash('conversation cleared')
      return
    }
    if (c.name === 'compact') return performCompaction(args)
    if (c.name === 'cost') {
      const state = derived()
      const entries = Object.entries(state.usageByModel)
      if (entries.length === 0) return flash('no usage yet')
      const costOf = (byModel) =>
        Object.entries(byModel).reduce((sum, [name, usage]) => sum + estimateCost(findModel(models, name), usage), 0)
      const spent = costOf(state.usageByModel)
      const active = costOf(state.usageActiveByModel)
      const { promptTokens, completionTokens } = state.usage
      const base = `$${spent.toFixed(4)} spent · ${promptTokens.toLocaleString()} in · ${completionTokens.toLocaleString()} out`
      flash(spent - active > 0.00005 ? `${base} · current conversation $${active.toFixed(4)}` : base)
      return
    }
    if (c.name === 'export') {
      const file = join(cwd, `pico-export-${Date.now()}.md`)
      await writeFile(file, transcriptToMarkdown(derived().transcript, { title: `pico session · ${cwd}` }))
      flash(`exported to ${file}`)
      return
    }
  }

  async function refreshAuthProviders() {
    const openai = await openaiStatus().catch(() => ({ connected: false, email: null }))
    setAuthProviders([
      { id: 'openai', label: 'OpenAI · ChatGPT / Codex plan', connected: openai.connected, email: openai.email },
    ])
  }

  function openConnectPanel() {
    setShowConnectPanel(true)
    refreshAuthProviders()
  }

  function connectProvider(provider) {
    if (provider.id !== 'openai') return
    setShowConnectPanel(false)
    flash('opening your browser for ChatGPT sign-in...')
    connectOpenAI()
      .then(async ({ email }) => {
        boot.providers = [...new Set([...boot.providers, 'codex'])]
        const creds = await openaiCredentials().catch(() => null)
        const codex = (await loadCodexModels(creds)).map((m) => ({ ...m, available: true, keyHint: '/connect' }))
        boot.models = [...boot.models.filter((m) => m.provider !== 'codex'), ...codex]
        reDerive()
        flash(`connected as ${email || 'your ChatGPT account'} · ${codex.length} codex models unlocked in /model`)
      })
      .catch((err) => flash(`connect failed: ${String(err.message || err).slice(0, 120)}`))
  }

  async function disconnectProvider(provider) {
    if (provider.id !== 'openai') return
    await disconnectOpenAI().catch(() => {})
    boot.providers = boot.providers.filter((p) => p !== 'codex')
    boot.models = boot.models.map((m) => (m.provider === 'codex' ? { ...m, available: false } : m))
    if (model().provider === 'codex') setModel(defaultModel())
    refreshAuthProviders()
    flash('disconnected from ChatGPT')
  }

  function refreshSessions(scopeIndex) {
    setResumeLoading(true)
    listSessions({ scope: RESUME_SCOPES[scopeIndex], root })
      .then((sessions) => setResumeSessions(sessions.filter((s) => s.header.id !== refs.session?.id)))
      .finally(() => setResumeLoading(false))
  }

  function shortenPath(path) {
    const home = homedir()
    return path.startsWith(home) ? path.replace(home, '~') : path
  }

  function openProjectPanel() {
    setShowProjectPanel(true)
    setProjectsLoading(true)
    listSessions({ scope: 'everywhere', root })
      .then((metas) => {
        const byRoot = new Map()
        for (const m of metas) {
          const entry = byRoot.get(m.header.root)
          if (!entry) {
            byRoot.set(m.header.root, {
              root: m.header.root,
              path: shortenPath(m.header.root),
              latest: m,
              count: 1,
              current: m.header.root === boot.root,
            })
          } else {
            entry.count++
          }
        }
        setProjects([...byRoot.values()])
      })
      .finally(() => setProjectsLoading(false))
  }

  async function deleteProject(p) {
    if (p.current) return flash('cannot delete the current project · switch away first')
    const armed = refs.projectDeleteArm
    if (!armed || armed.root !== p.root || Date.now() - armed.at > 3000) {
      refs.projectDeleteArm = { root: p.root, at: Date.now() }
      return flash(`ctrl+x again to delete "${p.path}" and its ${p.count} ${p.count === 1 ? 'session' : 'sessions'}`)
    }
    refs.projectDeleteArm = null
    try {
      await deleteProjectData(p.root)
      setProjects((list) => list.filter((x) => x.root !== p.root))
      flash(`deleted ${p.path} · ${p.count} ${p.count === 1 ? 'session' : 'sessions'} removed`)
    } catch (err) {
      flash(`delete failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function switchProject(meta) {
    if (busy()) return flash('finish or interrupt the current turn first')
    try {
      const previousMcp = boot.mcp
      const next = await boot.rebuild(meta.header.root)
      previousMcp.closeAll().catch(() => {})
      process.chdir(next.cwd)
      Object.assign(boot, next)
      process.stdout.write(`\x1b]0;pico · ${next.root.split('/').pop()}\x07`)
      next.mcp.connectAll()
      setMcpServers(next.mcp.list())
      setQueued([])
      setFileList([])
      await resumeSession(meta)
      flash(`switched to ${next.displayCwd}`)
    } catch (err) {
      flash(`switch failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function deleteSessionMeta(meta) {
    if (refs.session?.id === meta.header.id) {
      return flash('cannot delete the active session · /new first, then delete it')
    }
    const armed = refs.deleteArm
    if (!armed || armed.file !== meta.file || Date.now() - armed.at > 3000) {
      refs.deleteArm = { file: meta.file, at: Date.now() }
      return flash(`ctrl+x again to delete "${meta.title.slice(0, 50)}"`)
    }
    refs.deleteArm = null
    try {
      await deleteSession(meta.file)
      refreshSessions(resumeScope())
      flash('session deleted')
    } catch (err) {
      flash(`delete failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function resumeSession(meta) {
    setShowResumePanel(false)
    setShowProjectPanel(false)
    if (meta.header.root !== boot.root) return switchProject(meta)
    try {
      const { header, events } = await loadSession(meta.file)
      refs.session = openSession({ file: meta.file, header })
      refs.allEvents = [...events]
      refs.persisted = events.length
      refs.rewindUndo = null
      reDerive()
      const catalogMatch = models.find((m) => m.name === derived().model && m.available !== false)
      const restored = derived().model
        && (catalogMatch || adhocModel(derived().model, boot.providers))
      if (restored) {
        setModel(restored)
      } else {
        setModel(defaultModel())
        if (derived().model) flash(`model ${derived().model} unavailable, using ${defaultModel().name}`)
      }
      setEffort(derived().effort === undefined ? defaultEffort() : derived().effort)
      setSent(userEntries(derived()).map((e) => ({ text: recallText(e), at: header.createdAt })))
      setHistWindow(HISTORY_WINDOW)
      setFollow(true)
      flash(`resumed · ${meta.turns} ${meta.turns === 1 ? 'turn' : 'turns'} · ${timeAgo(meta.at)}`)
    } catch (err) {
      flash(`resume failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  function openHistorySearch() {
    const session = sent()
    setHistPrompts(dedupePrompts(session))
    setShowHistoryPanel(true)
    setHistScope(0)
  }

  function dedupePrompts(pool) {
    const seen = new Set()
    const out = []
    for (const entry of [...pool].sort((a, b) => b.at - a.at)) {
      if (seen.has(entry.text)) continue
      seen.add(entry.text)
      out.push(entry)
    }
    return out
  }

  async function switchHistScope(next) {
    setHistScope(next)
    if (next === 0) return setHistPrompts(dedupePrompts(sent()))
    const project = await loadProjectPrompts(root)
    if (next === 1) return setHistPrompts(dedupePrompts([...sent(), ...project]))
    const global = await loadGlobalPrompts()
    setHistPrompts(dedupePrompts([...sent(), ...project, ...global]))
  }

  async function performRewind(opt) {
    const target = rewindTarget()
    const state = derived()
    const { edits } = rewindStats(state, target.index)
    const editsLabel = `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}`
    let reverted = []
    let skipped = []

    if (opt.key === 'both' || opt.key === 'code') {
      const result = await revertEdits(edits)
      reverted = result.reverted
      skipped = result.skipped
    }

    let summaryText = null
    if (opt.key === 'summary') {
      const tail = state.transcript.slice(target.index)
      const text = tail.filter((m) => m.text).map((m) => `${m.kind}: ${m.text}`).join('\n')
      flash('summarizing...')
      let auth = null
      if (model().provider === 'codex') auth = await openaiCredentials().catch(() => null)
      summaryText = await summarizeText({ text, modelName: model().name, auth }).catch(() => {
        flash('summary model call failed · kept a crude digest of the rewound turns')
        return tail.filter((m) => m.text).slice(0, 3).map((m) => m.text.split(/\s+/).slice(0, 6).join(' ')).join(' · ')
      })
    }

    const event = makeEvent('rewind', { target: target.eventId, mode: opt.key, summaryText, reverted, skipped })
    persist(event)
    refs.rewindUndo = { rewindId: event.id, edits: edits.filter((e) => reverted.includes(e.callId)) }
    reDerive()
    if (opt.key !== 'code') setInput(recallText(target))

    const skippedNote = skipped.length ? ` · skipped ${skipped.length} drifted` : ''
    if (opt.key === 'code') flash(`reverted ${editsLabel}, conversation kept${skippedNote} · ctrl+z to undo`)
    else if (opt.key === 'summary') flash(`rewound and summarized${skippedNote} · ctrl+z to undo`)
    else if (opt.key === 'both') flash(`rewound, ${editsLabel} reverted${skippedNote} · ctrl+z to undo`)
    else flash(`rewound, file changes kept · ctrl+z to undo`)
    setRewindStep(null)
    setRewindTarget(null)
  }

  async function undoRewind() {
    const undo = refs.rewindUndo
    if (!undo) return
    const { skipped } = await reapplyEdits(undo.edits)
    persist(makeEvent('rewind_undo', { rewindId: undo.rewindId }))
    refs.rewindUndo = null
    reDerive()
    flash(skipped.length ? `rewind undone · ${skipped.length} file(s) drifted` : 'rewind undone')
  }

  function recallText(entry) {
    return inputTextFromContent(entry.content ?? entry.text, {
      attachments: refs.attachments,
      nextId: () => ++refs.imageCount,
    })
  }

  const anyPanel = () =>
    showModelPanel() || showEffortPanel() || showThemePanel() || showMemoryPanel() || showHistoryPanel() || showResumePanel() || showMcpPanel() ||
    showProjectPanel() || showShellsPanel() || showWakeupsPanel() || showConnectPanel() ||
    infoPanel() !== null || rewindStep() !== null

  // every focus-taking panel dims the conversation behind it; the theme
  // picker is the one exemption, since its job is previewing palettes on
  // the undimmed ui
  const dimmingPanel = () => anyPanel() && !showThemePanel()

  function killShell(shell) {
    if (shell.status !== 'running') return flash(`shell ${shell.id} already exited`)
    const armed = refs.shellKillArm
    if (!armed || armed.id !== shell.id || Date.now() - armed.at > 3000) {
      refs.shellKillArm = { id: shell.id, at: Date.now() }
      return flash(`ctrl+x again to kill "${shell.description || `shell ${shell.id}`}"`)
    }
    refs.shellKillArm = null
    boot.shells.kill(shell.id, 'user')
  }

  const effortApplies = () => !!model().effort

  function setSessionEffort(next, { asDefault = false } = {}) {
    persist(makeEvent('effort', { to: next }))
    setEffort(next)
    if (asDefault) {
      setDefaultEffort(next)
      writeConfig({ defaultEffort: next }).catch(() => {})
    }
    flash(`effort: ${next ?? 'default'}${asDefault ? ' · saved as default' : ''}`)
  }

  const fm = useFocus({ initial: 'input' })
  fm.item('feed')
  fm.item('input')
  useFocusTrap(anyPanel() || view() === 'help')
  useSelection({
    onCopy: (text) => flash(`copied ${text.length} ${text.length === 1 ? 'character' : 'characters'}`),
  })

  useInput((event) => {
    if (event.key === 'escape' && busy() && !anyPanel()) {
      interrupt()
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'c') {
      const now = Date.now()
      if (now - refs.quitAt < 1500) {
        boot.shells.killAll()
        mcp.closeAll().catch(() => {}).finally(() => process.exit(0))
      } else {
        refs.quitAt = now
        const running = boot.shells.running()
        flash(running ? `${running} ${running === 1 ? 'shell' : 'shells'} running · ctrl+c again to exit and kill ${running === 1 ? 'it' : 'them'}` : 'ctrl+c again to exit')
      }
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'o') {
      setVerbose((v) => !v)
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'r' && view() === 'chat' && !anyPanel()) {
      openHistorySearch()
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 's' && view() === 'chat' && !anyPanel()) {
      setShowResumePanel(true)
      refreshSessions(resumeScope())
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 't' && view() === 'chat' && !anyPanel()) {
      setShowModelPanel(true)
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'p' && view() === 'chat' && !anyPanel()) {
      openProjectPanel()
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'b' && view() === 'chat' && !anyPanel()) {
      if (!effortApplies()) flash(`${model().name} does not support effort control`)
      else {
        const order = [null, 'low', 'medium', 'high', 'max']
        const next = order[(order.indexOf(effort() ?? null) + 1) % order.length]
        setSessionEffort(next)
      }
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 's' && showHistoryPanel()) {
      switchHistScope((histScope() + 1) % HISTORY_SCOPES.length)
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 's' && showMemoryPanel()) {
      setMemScope((s) => (s + 1) % MEMORY_SCOPES.length)
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 's' && showResumePanel()) {
      const next = (resumeScope() + 1) % RESUME_SCOPES.length
      setResumeScope(next)
      refreshSessions(next)
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'z' && refs.rewindUndo && !busy() && view() === 'chat') {
      undoRewind()
      event.stopPropagation()
    }
  })

  const fmtElapsed = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)
  const elapsed = fmtElapsed(busy() ? Math.max(0, Math.floor((Date.now() - startedAt()) / 1000)) : 0)

  const slashQuery = input().startsWith('/') ? input().slice(1) : null
  const showCommands = slashQuery !== null && !slashQuery.includes(' ') && !anyPanel()
  const matchedCommands = !showCommands
    ? []
    : cmdCycle()
      ? cmdCycle().matches
      : allCommands.filter((c) => c.name.toLowerCase().startsWith(slashQuery.toLowerCase()))

  const atMatch = input().match(/(^|[\s(])@([^\s@]*)$/)
  const showFiles = atMatch !== null && !showCommands && !filesDismissed() && !anyPanel()
  if (showFiles) {
    listFiles(cwd).then((files) => {
      if (files !== fileList()) setFileList(files)
    })
  }
  const matchedFiles = showFiles
    ? fileList()
        .map((f) => [fuzzyScore(atMatch[2], f), f])
        .filter(([score]) => score >= 0)
        .sort((a, b) => b[0] - a[0])
        .map(([, f]) => f)
    : []

  function pickFile(f) {
    const v = input()
    const at = v.lastIndexOf('@')
    const mediaType = mediaTypeFor(f)
    const full = join(boot.cwd, f)
    if (mediaType && existsSync(full)) {
      const placeholder = `[Image #${++refs.imageCount}]`
      refs.attachments.set(placeholder, { path: full, mediaType })
      setInput(v.slice(0, at) + placeholder + ' ')
    } else {
      setInput(v.slice(0, at + 1) + f + ' ')
    }
    setFileIndex(0)
  }

  const compCtx = completing() ? completionContext({ value: input(), resolve: completionSource }) : null
  const showCompletion = !!compCtx && compCtx.matches.length > 0 && !showCommands && !showFiles && !anyPanel()

  const rewindEntries = () => userEntries(derived())
  const rewindOptions = (() => {
    const target = rewindTarget()
    if (!target) return []
    const { msgs, edits } = rewindStats(derived(), target.index)
    const e = edits.length
    const editsLabel = `${e} ${e === 1 ? 'edit' : 'edits'}`
    const opts = []
    if (e > 0) opts.push({ key: 'both', label: 'restore code and conversation', desc: `chat returns to this message · ${editsLabel} reverted` })
    opts.push({
      key: 'chat',
      label: e > 0 ? 'restore conversation only' : 'restore conversation',
      desc: e > 0 ? 'chat returns to this message · file changes kept' : `chat returns to this message · drops ${msgs} entries`,
    })
    if (e > 0) opts.push({ key: 'code', label: 'restore code only', desc: `conversation kept · ${editsLabel} reverted` })
    opts.push({ key: 'summary', label: 'rewind and keep a summary', desc: 'dropped entries collapse into a one-line note' })
    return opts
  })()

  const { usageActive: usage } = derived()
  shellsVersion()
  const liveShells = boot.shells.list().filter((s) => s.status === 'running')
  const pendingWakeups = boot.wakeups.pending()

  if (view() === 'help') {
    return <Help commands={COMMANDS} onClose={() => setView('chat')} />
  }

  highlightVersion()

  const transcript = derived().transcript
  const hiddenCount = Math.max(0, transcript.length - histWindow())
  const items = [...transcript.slice(hiddenCount), ...overlay()]

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      <ScrollBox
        style={{ flexGrow: 1, dim: dimmingPanel() }}
        focused={fm.is('feed')}
        scrollOffset={follow() ? 1e9 : offset()}
        onScroll={(next, meta) => {
          setFollow(!!meta?.atBottom)
          // back at the bottom: loaded history is off-screen, so re-hiding
          // it is invisible and restores the small render window
          if (meta?.atBottom && histWindow() > HISTORY_WINDOW) setHistWindow(HISTORY_WINDOW)
          if (next === 0 && hiddenCount > 0) {
            // keep the view anchored: estimate the rows the new batch adds
            // and scroll past them so the current top item stays in place
            const added = Math.min(HISTORY_WINDOW, hiddenCount)
            const avgRows = Math.max(2, Math.round((meta?.maxOffset || 0) / Math.max(1, items.length)))
            setHistWindow((w) => w + HISTORY_WINDOW)
            setOffset(added * avgRows)
            return
          }
          setOffset(next)
        }}
        scrollbar
      >
        {items.length === 0 && <Banner version={version} />}
        {hiddenCount > 0 && (
          <box style={{ paddingX: 2 }}>
            <text style={{ color: FAINT, italic: true }}>{`⌃ ${hiddenCount.toLocaleString()} older ${hiddenCount === 1 ? 'message' : 'messages'} · scroll to top to load`}</text>
          </box>
        )}
        {items.map((item, i) => <Message key={hiddenCount + i} item={item} verbose={verbose()} />)}
        {streaming() !== null && streaming() !== '' && (
          <Message key="streaming" item={{ kind: 'assistant', text: `${streaming()}▋` }} />
        )}
      </ScrollBox>

      {queued().length > 0 && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          {queued().map((q, i) => (
            <box key={i} style={{ flexDirection: 'row' }}>
              <text style={{ color: FAINT }}>{'› '}</text>
              <box style={{ flexGrow: 1, height: 1 }}>
                <text style={{ overflow: 'truncate', color: MUTED }}>{q.replace(/\n/g, ' ')}</text>
              </box>
              {i === 0 && <text style={{ color: FAINT, dim: true }}>{'  pending · ↑ to edit'}</text>}
            </box>
          ))}
        </box>
      )}

      <box style={{ bg: PANEL_BG, flexDirection: 'row', paddingX: 2, paddingY: 1, marginTop: 1, dim: dimmingPanel() }}>
        <text style={{ color: accent(), bold: true }}>{'❯'}</text>
        <text> </text>
        {derived().title && (
          <box style={{ position: 'absolute', top: 0, right: 0 }}>
            <text style={{ bg: accent(), color: 'black', bold: true }}>{` ${derived().title} `}</text>
          </box>
        )}
        <TextArea
          color={FG}
          lineCounter
          value={input()}
          onChange={(v) => {
            const converted = placeholderizeImagePaths(v, {
              attachments: refs.attachments,
              nextId: () => ++refs.imageCount,
            })
            setInput(converted.text)
            setCmdIndex(0)
            setCmdCycle(null)
            setFileIndex(0)
            setHistIdx(-1)
            setFilesDismissed(false)
          }}
          onCancel={() => {
            if (busy()) interrupt()
            else {
              setCmdCycle(null)
              setCompleting(false)
              setFilesDismissed(true)
            }
          }}
          onSubmit={send}
          onKeyDown={(e) => {
            if (e.key === 'tab' && !e.ctrl && !e.meta && showFiles && matchedFiles.length > 0) {
              pickFile(matchedFiles[Math.min(fileIndex(), matchedFiles.length - 1)])
              return true
            }
            if (e.key === 'tab' && !e.ctrl && !e.meta && showCommands && matchedCommands.length > 0) {
              const cycle = cmdCycle()
              if (!cycle) {
                const start = Math.min(cmdIndex(), matchedCommands.length - 1)
                setCmdCycle({ matches: matchedCommands })
                setCmdIndex(start)
                setInput('/' + matchedCommands[start].name)
              } else {
                const next = (cmdIndex() + 1) % cycle.matches.length
                setCmdIndex(next)
                setInput('/' + cycle.matches[next].name)
              }
              return true
            }
            if (e.key === 'paste' && e.text) {
              const paths = extractImagePaths(e.text)
              if (paths.length > 0) {
                const placeholders = paths.map((path) => {
                  const placeholder = `[Image #${++refs.imageCount}]`
                  refs.attachments.set(placeholder, { path, mediaType: mediaTypeFor(path) })
                  return placeholder
                })
                const at = e.cursor ?? e.value.length
                setInput(e.value.slice(0, at) + placeholders.join(' ') + e.value.slice(at))
                return true
              }
              return false
            }
            if (e.key === 'backspace' && e.cursor > 0) {
              const match = e.value.slice(0, e.cursor).match(/\[Image #\d+\]$/)
              if (match) {
                refs.attachments.delete(match[0])
                setInput(e.value.slice(0, e.cursor - match[0].length) + e.value.slice(e.cursor))
                return true
              }
            }
            if (e.key === 'tab' && !e.ctrl && !e.meta) {
              const ctx = completionContext({ value: e.value, resolve: completionSource })
              if (!ctx) return false
              if (!completing()) {
                setCompleting(true)
                setCompIndex(0)
                listFiles(cwd).then((files) => {
                  if (files !== fileList()) setFileList(files)
                })
              } else if (ctx.matches.length > 0) {
                acceptCompletion(e.value, ctx, ctx.matches[Math.min(compIndex(), ctx.matches.length - 1)])
              }
              return true
            }
            if (e.ctrl || e.meta || showCommands || showFiles) return false
            if (e.key === 'up' && e.value === '' && queued().length > 0) {
              setInput(queued().join('\n'))
              setQueued([])
              return true
            }
            const browsing = histIdx() >= 0
            if (e.key === 'up' && (browsing || e.value === '') && histIdx() < sent().length - 1) {
              const n = histIdx() + 1
              setHistIdx(n)
              setInput(sent()[sent().length - 1 - n].text)
              return true
            }
            if (e.key === 'down' && browsing) {
              const n = histIdx() - 1
              setHistIdx(n)
              setInput(n < 0 ? '' : sent()[sent().length - 1 - n].text)
              return true
            }
            return false
          }}
          submitOnEnter
          clearOnSubmit
          focused={fm.is('input') && !anyPanel()}
          maxHeight={8}
          placeholder="enter to send · / commands · @ files · tab to scroll"
          cursor={{ blink: true, bg: accent(), color: 'black' }}
        />
      </box>

      {showCommands && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          {matchedCommands.length === 0 ? (
            <text style={{ color: FAINT }}>no matching commands</text>
          ) : (
            <Menu
              counter
              items={matchedCommands}
              selected={cmdIndex()}
              onSelect={setCmdIndex}
              onSubmit={(c) => runCommand(c)}
              focused={showCommands}
              maxVisible={5}
              scrolloff={2}
              renderItem={(c, { active }) => (
                <box style={{ flexDirection: 'row' }}>
                  <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                  <text style={{ color: active ? accent() : MUTED }}>{`/${c.name}`.padEnd(matchedCommands.reduce((m, x) => Math.max(m, x.name.length + 3), 12))}</text>
                  <text style={{ color: active ? '#cbd5e1' : FAINT }}>{c.desc}</text>
                </box>
              )}
            />
          )}
        </box>
      )}

      {showFiles && matchedFiles.length > 0 && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          <Menu
            counter
            items={matchedFiles}
            selected={fileIndex()}
            onSelect={setFileIndex}
            onSubmit={pickFile}
            onCancel={() => setFilesDismissed(true)}
            focused={showFiles}
            maxVisible={5}
            scrolloff={2}
            renderItem={(f, { active }) => (
              <box style={{ flexDirection: 'row' }}>
                <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                <text style={{ color: active ? accent() : FG_SOFT }}>{f}</text>
              </box>
            )}
          />
        </box>
      )}

      {showCompletion && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          <Menu
            counter
            items={compCtx.matches}
            selected={compIndex()}
            onSelect={setCompIndex}
            onSubmit={(candidate) => acceptCompletion(input(), compCtx, candidate)}
            onCancel={dismissCompletion}
            focused={showCompletion}
            maxVisible={5}
            scrolloff={2}
            renderItem={(candidate, { active }) => (
              <box style={{ flexDirection: 'row' }}>
                <text style={{ color: accent() }}>{active ? '› ' : '  '}</text>
                <text style={{ color: active ? accent() : FG_SOFT }}>{candidate}</text>
              </box>
            )}
          />
        </box>
      )}

      {showModelPanel() && (
        <ModelPanel
          models={models}
          current={model().name}
          defaultName={defaultModel().name}
          focused={showModelPanel()}
          onPick={(m) => {
            if (m.available === false) return flash(`set ${m.keyHint} in your environment to use ${m.name}`)
            persist(makeEvent('model_switch', { from: model().name, to: m.name }))
            setModel(m)
            setShowModelPanel(false)
            flash(`model set to ${m.name}`)
          }}
          onPickDefault={(m) => {
            if (m.available === false) return flash(`set ${m.keyHint} in your environment to use ${m.name}`)
            persist(makeEvent('model_switch', { from: model().name, to: m.name }))
            setModel(m)
            setDefaultModel(m)
            writeConfig({ defaultModel: m.name }).catch(() => {})
            setShowModelPanel(false)
            flash(`model set to ${m.name} · saved as default`)
          }}
          onClose={() => setShowModelPanel(false)}
        />
      )}

      {showEffortPanel() && (
        <EffortPanel
          levels={EFFORT_LEVELS}
          current={effort() ?? null}
          defaultLevel={defaultEffort() ?? null}
          focused={showEffortPanel()}
          onPick={(l) => {
            setSessionEffort(l.key)
            setShowEffortPanel(false)
          }}
          onPickDefault={(l) => {
            setSessionEffort(l.key, { asDefault: true })
            setShowEffortPanel(false)
          }}
          onClose={() => setShowEffortPanel(false)}
        />
      )}

      {showThemePanel() && (
        <ThemePanel
          themes={themeItems()}
          pref={themePref()}
          focused={showThemePanel()}
          onPick={(t) => {
            setShowThemePanel(false)
            applyThemePref(t.key)
          }}
          onPreview={(t) => previewPalette(t.key)}
          onClose={() => {
            setShowThemePanel(false)
            previewPalette(themePref())
          }}
        />
      )}

      {showHistoryPanel() && (
        <HistoryPanel
          prompts={histPrompts()}
          scopes={HISTORY_SCOPES}
          scopeIndex={histScope()}
          focused={showHistoryPanel()}
          onPick={(text) => { setInput(text); setShowHistoryPanel(false) }}
          onClose={() => setShowHistoryPanel(false)}
        />
      )}

      {showResumePanel() && (
        <ResumePanel
          sessions={resumeSessions()}
          scopes={RESUME_SCOPES}
          scopeIndex={resumeScope()}
          loading={resumeLoading()}
          focused={showResumePanel()}
          onPick={resumeSession}
          onDelete={deleteSessionMeta}
          onClose={() => setShowResumePanel(false)}
        />
      )}

      {showMemoryPanel() && (
        <MemoryPanel
          memories={memoryList().filter((m) => MEMORY_SCOPES[memScope()] === 'all' || m.scope === MEMORY_SCOPES[memScope()])}
          scopes={MEMORY_SCOPES}
          scopeIndex={memScope()}
          focused={showMemoryPanel()}
          onForget={forgetMemory}
          onClose={() => setShowMemoryPanel(false)}
        />
      )}

      {infoPanel() && (
        <InfoListPanel
          title={infoPanel().title}
          rows={infoPanel().rows}
          focused={infoPanel() !== null}
          onClose={() => setInfoPanel(null)}
        />
      )}

      {showProjectPanel() && (
        <ProjectPanel
          projects={projects()}
          loading={projectsLoading()}
          focused={showProjectPanel()}
          onPick={(p) => resumeSession(p.latest)}
          onDelete={deleteProject}
          onClose={() => setShowProjectPanel(false)}
        />
      )}

      {showShellsPanel() && (
        <ShellsPanel
          version={shellsVersion()}
          shells={boot.shells.list()}
          readOutput={(id) => {
            try {
              return boot.shells.output(id, { tail: 2000 })
            } catch {
              return null
            }
          }}
          focused={showShellsPanel()}
          onKill={killShell}
          onDismiss={(s) => boot.shells.dismiss(s.id)}
          onClose={() => setShowShellsPanel(false)}
        />
      )}

      {showConnectPanel() && (
        <ConnectPanel
          providers={authProviders()}
          focused={showConnectPanel()}
          onConnect={connectProvider}
          onDisconnect={disconnectProvider}
          onClose={() => setShowConnectPanel(false)}
        />
      )}

      {showWakeupsPanel() && (
        <WakeupsPanel
          wakeups={(shellsVersion(), boot.wakeups.list())}
          focused={showWakeupsPanel()}
          onCancel={(w) => {
            boot.wakeups.cancel(w.id)
            flash(`cancelled wake-up ${w.id}`)
            noteSystem(
              `[system notification] the user cancelled scheduled wake-up ${w.id} (note was: ${w.note.replace(/\n/g, ' ')}). This was deliberate; do not reschedule it unless asked.`,
              { wake: false },
            )
          }}
          onClose={() => setShowWakeupsPanel(false)}
        />
      )}

      {showMcpPanel() && (
        <McpPanel
          servers={mcpServers()}
          focused={showMcpPanel()}
          onToggle={(name) => mcp.toggle(name)}
          onReconnect={(name) => mcp.reconnect(name)}
          onRemove={(name) => mcp.remove(name)}
          onAdd={(name, command, scope) => {
            mcp.add(name, command, scope)
            flash(`added ${name} (${scope})`)
          }}
          onInvalid={flash}
          onClose={() => setShowMcpPanel(false)}
        />
      )}

      {rewindStep() === 'pick' && (
        <RewindPickPanel
          entries={[...rewindEntries()].reverse()}
          stats={(index) => rewindStats(derived(), index)}
          focused={rewindStep() === 'pick'}
          onPick={(entry) => { setRewindTarget(entry); setRewindStep('action') }}
          onClose={() => setRewindStep(null)}
        />
      )}

      {rewindStep() === 'action' && rewindTarget() && (
        <RewindActionPanel
          target={rewindTarget()}
          options={rewindOptions}
          focused={rewindStep() === 'action'}
          onSubmit={performRewind}
          onBack={() => setRewindStep('pick')}
        />
      )}

      {liveShells.length > 0 && !showShellsPanel() && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          {liveShells.slice(0, SHELL_STRIP_MAX).map((s) => (
            <box key={s.id} style={{ flexDirection: 'row' }}>
              <text style={{ color: accent() }}>{'⚙ '}</text>
              <text style={{ color: MUTED }}>{`${s.id} · `}</text>
              <box style={{ flexGrow: 1, height: 1 }}>
                <text style={{ overflow: 'truncate', color: FG_SOFT }}>{s.description || s.command.replace(/\n/g, ' ')}</text>
              </box>
              <text style={{ color: MUTED }}>{`  ${Date.now() - s.startedAt < 60000 ? '<1m' : timeAgo(s.startedAt).replace(' ago', '')}`}</text>
            </box>
          ))}
          <box style={{ flexDirection: 'row' }}>
            <text style={{ color: MUTED }}>
              {`  ${liveShells.length > SHELL_STRIP_MAX ? `+${liveShells.length - SHELL_STRIP_MAX} more · ` : ''}/shells`}
            </text>
          </box>
        </box>
      )}

      <box style={{ flexDirection: 'row', paddingX: 2, gap: 1, marginTop: 1 }}>
        {busy()
          ? (
            <box style={{ flexDirection: 'row' }}>
              <Shimmer color={accent()} highlight={HIGHLIGHT} duration={1500} reverse>
                {compacting()
                  ? compactStatus()?.phase === 'writing' ? `Compacting · writing ${compactStatus().section}/8` : 'Compacting · analyzing'
                  : thinkingNow() ? 'Thinking' : 'Responding'}
              </Shimmer>
              <text style={{ color: FAINT }}>{` (${elapsed}${compactStatus() ? ` · ↓ ${fmtTokens(Math.round(compactStatus().chars / 4))} tokens` : ''}) · esc to interrupt`}</text>
              {compactStatus()?.phase === 'writing' && (
                <box style={{ flexDirection: 'row', marginLeft: 1, width: 16 }}>
                  <ProgressBar variant="thin" value={compactStatus().section / 8} width={16} percentage={false} color={accent()} />
                </box>
              )}
            </box>
          )
          : <text style={{ color: FAINT, overflow: 'truncate' }}>{boot.displayCwd}</text>}
        <box style={{ flexGrow: 1 }} />
        {process.env.PICO_PERF && (() => {
          const stats = useFrameStats()
          return <text style={{ color: MUTED }}>{`⏱ ${(stats.renderMs ?? 0).toFixed(1)}ms · ${stats.fps}fps · ${derived().transcript.length} items`}</text>
        })()}
        {pendingWakeups > 0 && <text style={{ color: MUTED }}>{`⏰ ${pendingWakeups}`}</text>}
        <text style={{ color: accent() }}>{model().name}</text>
        {effortApplies() && effort() && <text style={{ color: MUTED }}>{`· ${effort()}`}</text>}
        <text style={{ color: FAINT }}>↑</text>
        <text style={{ color: MUTED }}>{`${usage.promptTokens.toLocaleString()} in`}</text>
        <text style={{ color: FAINT }}>↓</text>
        <text style={{ color: MUTED }}>{`${usage.completionTokens.toLocaleString()} out`}</text>
        {usage.thoughtTokens > 0 && <text style={{ color: FAINT }}>{`✦ ${usage.thoughtTokens.toLocaleString()} think`}</text>}
        {model().context > 0 && derived().lastPromptTokens > 0 && derived().lastPromptModel === model().name && (() => {
          const pct = Math.min(100, Math.round((derived().lastPromptTokens / model().context) * 100))
          return <text style={{ color: pct >= 80 ? RED : MUTED }}>{`ctx ${pct}%`}</text>
        })()}
      </box>
    </box>
  )
}
