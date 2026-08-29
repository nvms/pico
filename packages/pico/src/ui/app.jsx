import { homedir } from 'node:os'
import { createSignal, Menu, ProgressBar, ScrollBox, Shimmer, Spinner, TextArea, useFocus, useFocusTrap, useFrameStats, useHitTest, useInput, useLayout, useMouse, useResize, useSelection, useToast } from '@trendr/core'
import { makeEvent } from 'picocode-core/events.js'
import { listSessions, deleteSession, deleteProjectData } from 'picocode-core/session.js'
import { userEntries, rewindStats } from 'picocode-core/derive.js'
import { loadProjectPrompts, loadGlobalPrompts } from 'picocode-core/history.js'
import { implicitRewindTarget } from 'picocode-core/rewind.js'
import { checkForUpdate, fetchLatestVersion, newerVersion, isDevInstall, runUpdate } from 'picocode-core/update.js'
import { STEER_ROLES, steerableTranscript } from 'picocode-core/steer.js'
import { writeConfig } from 'picocode-core/config.js'
import { openaiStatus } from 'picocode-core/openai-auth.js'
import { EFFORT_LEVELS, SESSION_COLORS } from 'picocode-core/controller.js'
import { agentTranscript } from 'picocode-core/agent-transcript.js'
import { fuzzyScore } from 'picocode-core/fuzzy.js'
import { completionContext, applyCompletion } from 'picocode-core/completion.js'
import { extractImagePaths, placeholderizeImagePaths } from 'picocode-core/attachments.js'
import { listFiles } from 'picocode-core/files.js'
import { highlightVersion } from './highlight.js'
import { compactNumber } from 'picocode-core/format.js'
import { AnimatedValue } from './animated-value.jsx'
import { Message } from './transcript.jsx'
import { ConversationSearchBar, ConversationScrollAnchor, ConversationSearchMessage, createConversationSearch } from './conversation-search-view.jsx'
import { QuestionForm } from './question-form.jsx'
import { EmptyState } from './empty-state.jsx'
import { Help } from './help.jsx'
import { ModelPanel, EffortPanel, ThemePanel, ConfigPanel, ConfirmPanel, HistoryPanel, RewindPickPanel, RewindActionPanel, ResumePanel, ProjectPanel, McpPanel, MemoryPanel, InfoListPanel, WakeupsPanel, ConnectPanel, timeAgo } from './panels.jsx'
import { accent, setAccent, setPalette, paletteName, paletteList, DEFAULT_ACCENT, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, RED, GREEN, HIGHLIGHT } from './theme.js'

const COMMANDS = [
  { name: 'model', desc: 'Switch the active model for this session' },
  { name: 'connect', desc: 'Sign in with ChatGPT to use a Codex subscription' },
  { name: 'effort', desc: 'Set the thinking effort for this session' },
  { name: 'resume', desc: 'Pick up a previous session where you left off' },
  { name: 'new', desc: 'Start a new session in this project' },
  { name: 'fork', desc: 'Fork this conversation into a named session: /fork <label>' },
  { name: 'delete', desc: 'Permanently delete the current session and start fresh' },
  { name: 'project', desc: 'Switch projects: jump to another project, same as ctrl+p' },
  { name: 'cwd', desc: 'Show the current working directory and project root' },
  { name: 'skills', desc: 'List every skill: builtin, global, and project' },
  { name: 'commands', desc: 'List every command: builtin, global, and project' },
  { name: 'init', desc: 'Create or improve repository AGENTS.md guidance' },
  { name: 'tools', desc: 'List builtin and user-defined tools; MCP tools live in /mcp' },
  { name: 'rewind', desc: 'Restore the conversation to a previous message' },
  { name: 'steer', desc: 'Edit or add conversation messages without sending' },
  { name: 'history', desc: 'Search prompts you previously sent' },
  { name: 'rename', desc: 'Name this session; omit the name to restore its automatic title' },
  { name: 'color', desc: 'Color this session: /color <name or #hex>, /color none to clear' },
  { name: 'theme', desc: 'Pick a color theme; /theme <name> applies one directly' },
  { name: 'config', desc: 'Configure pico display and behavior' },
  { name: 'mcp', desc: 'Manage MCP servers: add, toggle, reconnect' },
  { name: 'parallel', desc: 'Run a task with parallel agents: /parallel <task>' },
  { name: 'deliberate', desc: 'Deliberate on a decision: /deliberate <decision>' },
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

const HISTORY_SCOPES = ['session', 'project', 'everywhere']
const MEMORY_SCOPES = ['all', 'project', 'global']
const SHELL_STRIP_MAX = 5
const AGENT_STRIP_MAX = 5
const STRIP_SCROLLOFF = 1

function stripWindowStart(current, target, length, size) {
  const max = Math.max(0, length - size)
  const start = Math.max(0, Math.min(current, max))
  if (target < 0) return start
  if (target < start + STRIP_SCROLLOFF) return Math.max(0, target - STRIP_SCROLLOFF)
  if (target >= start + size - STRIP_SCROLLOFF) return Math.min(max, target - size + STRIP_SCROLLOFF + 1)
  return start
}


function agentElapsed(agent, now = Date.now()) {
  if (!agent.startedAt) return 'waiting'
  const seconds = Math.max(0, Math.floor(((agent.endedAt || now) - agent.startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours) return `${hours}h ${minutes % 60}m`
  if (minutes) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function agentStatus(agent) {
  if (agent.status === 'running') return { icon: '', label: '', color: accent() }
  if (agent.status === 'queued') return { icon: '◌', label: 'queued', color: MUTED }
  if (agent.status === 'completed') return { icon: '●', label: '', color: GREEN }
  if (agent.status === 'failed') return { icon: '×', label: 'failed', color: RED }
  return { icon: '■', label: 'cancelled', color: MUTED }
}

function SteerMessage({ item, verbose, selected, focus }) {
  const layout = useLayout()
  focus.item(item.messageId, layout)
  return <Message item={item} verbose={verbose} showLocked />
}

function MouseFocusRegion({ children, onPress, ...props }) {
  const hitTest = useHitTest()
  useMouse((event) => {
    if (event.action === 'press' && event.button === 'left' && hitTest(event.x, event.y)) onPress()
  })
  return <box {...props}>{children}</box>
}

function AgentStripRow({ selected, focused, children, onPress }) {
  const hitTest = useHitTest()
  const [hovered, setHovered] = createSignal(false)
  useMouse((event) => {
    const inside = hitTest(event.x, event.y)
    if (event.action === 'move') setHovered(inside)
    if (inside && event.action === 'press' && event.button === 'left') {
      onPress()
      event.stopPropagation()
    }
  })
  return (
    <box style={{ flexDirection: 'row', bg: focused ? accent() : null, color: focused ? 'black' : hovered() ? FG_SOFT : MUTED }}>
      <text style={{ color: focused ? 'black' : selected ? accent() : MUTED, bold: selected }}>{selected ? '❯ ' : '  '}</text>
      {children}
    </box>
  )
}

// only the newest slice of a long transcript renders; older items load in
// batches when the user scrolls to the top. render cost is per-item, so this
// keeps day-long sessions as fast as fresh ones
const HISTORY_WINDOW = 50
const RESUME_SCOPES = ['project', 'everywhere']

function collapseSteerTools(items) {
  const collapsed = []
  let hidden = 0
  const flush = () => {
    if (!hidden) return
    collapsed.push({ kind: 'steer-tools', count: hidden })
    hidden = 0
  }
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'tool-group' || item.kind === 'thoughts') {
      hidden += item.kind === 'tool-group' ? item.items.length : 1
    } else {
      flush()
      collapsed.push(item)
    }
  }
  flush()
  return collapsed
}

function compactTranscriptRuns(items, active = false) {
  const result = []
  for (let i = 0; i < items.length;) {
    if (items[i].kind === 'tool' || items[i].kind === 'thoughts') {
      let end = i + 1
      while (end < items.length && (items[end].kind === 'tool' || items[end].kind === 'thoughts')) end++
      const run = items.slice(i, end)
      const tools = run.filter((item) => item.kind === 'tool')
      result.push({ kind: 'tool-group', callId: tools.at(-1)?.callId, items: run, tools, active: active && end === items.length })
      i = end
      continue
    }
    if (items[i].kind === 'notice' && items[i].agentCompletion) {
      let end = i + 1
      while (end < items.length && items[end].kind === 'notice' && items[end].agentCompletion) end++
      const run = items.slice(i, end)
      result.push(run.length === 1 ? run[0] : { kind: 'agent-notice-group', notices: run })
      i = end
      continue
    }
    result.push(items[i++])
  }
  return result
}

export function App({ boot, controller: ctl }) {
  const { cwd, root, version, models, skills, mcp } = boot
  const state = ctl.state

  const [derived, setDerived] = createSignal(state.derived)
  const [terminalWidth, setTerminalWidth] = createSignal(process.stdout.columns || 80)
  useResize(({ width }) => setTerminalWidth(width))
  const [overlay, setOverlay] = createSignal(state.overlay)
  const [streaming, setStreaming] = createSignal(state.streaming)
  const [turnPhase, setTurnPhase] = createSignal(state.turnPhase)
  const [busy, setBusy] = createSignal(state.busy)
  const [compacting, setCompacting] = createSignal(state.compacting)
  const [compactStatus, setCompactStatus] = createSignal(state.compactStatus)
  const [startedAt, setStartedAt] = createSignal(state.startedAt)
  const [input, setInput] = createSignal('')
  const [model, setModel] = createSignal(state.model)
  const [defaultModel, setDefaultModel] = createSignal(state.defaultModel)
  const [effort, setEffort] = createSignal(state.effort)
  const [defaultEffort, setDefaultEffort] = createSignal(state.defaultEffort)
  const [showEffortPanel, setShowEffortPanel] = createSignal(false)
  const [showThemePanel, setShowThemePanel] = createSignal(false)
  const [showConfigPanel, setShowConfigPanel] = createSignal(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false)
  const [clouds, setClouds] = createSignal(boot.clouds)
  const [compactToolHistory, setCompactToolHistory] = createSignal(boot.compactToolHistory)
  const [gitFooter, setGitFooter] = createSignal(boot.gitFooter)
  const [wideSidebar, setWideSidebar] = createSignal(boot.wideSidebar)
  const [researchAgentLimit, setResearchAgentLimit] = createSignal(boot.researchAgentLimit)
  const [questionRequest, setQuestionRequest] = createSignal(state.question)
  const [showMemoryPanel, setShowMemoryPanel] = createSignal(false)
  const [memScope, setMemScope] = createSignal(0)
  const [memoryList, setMemoryList] = createSignal([])
  const [themePref, setThemePref] = createSignal(boot.themePref || 'auto')
  const [queued, setQueued] = createSignal(state.queued)
  const [expedited, setExpedited] = createSignal(state.expedited)
  const [sent, setSent] = createSignal(state.sent)
  const [histIdx, setHistIdx] = createSignal(-1)
  const [cmdIndex, setCmdIndex] = createSignal(0)
  const [cmdCycle, setCmdCycle] = createSignal(null)
  const [fileIndex, setFileIndex] = createSignal(0)
  const [fileList, setFileList] = createSignal([])
  const [filesDismissed, setFilesDismissed] = createSignal(false)
  const [view, setViewSignal] = createSignal('chat')
  const [verbose, setVerbose] = createSignal(false)
  const [showModelPanel, setShowModelPanel] = createSignal(false)
  const [showResearchModelPanel, setShowResearchModelPanel] = createSignal(false)
  const [researchModelReturn, setResearchModelReturn] = createSignal(null)
  const [selectingDeliberationModel, setSelectingDeliberationModel] = createSignal(false)
  const [pendingResearch, setPendingResearch] = createSignal(null)
  const [pendingDeliberation, setPendingDeliberation] = createSignal(null)
  const [agentsVersion, setAgentsVersion] = createSignal(state.activityVersion)
  const [viewedAgentId, setViewedAgentId] = createSignal(null)
  const [agentWindowOffset, setAgentWindowOffset] = createSignal(0)
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
  const [viewedShellId, setViewedShellId] = createSignal(null)
  const [shellWindowOffset, setShellWindowOffset] = createSignal(0)
  const [showWakeupsPanel, setShowWakeupsPanel] = createSignal(false)
  const [showConnectPanel, setShowConnectPanel] = createSignal(false)
  const [authProviders, setAuthProviders] = createSignal([])
  const [shellsVersion, setShellsVersion] = createSignal(0)
  const [gitVersion, setGitVersion] = createSignal(0)
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
  const [steer, setSteer] = createSignal(null)
  const [steerText, setSteerText] = createSignal('')

  const refs = boot.refs
  refs.quitAt ??= 0

  function setView(next) {
    setViewSignal(next)
    ctl.hold(next !== 'chat')
  }

  // the controller owns every piece of conversation state; these signals
  // mirror it so the render tree below stays reactive without knowing that
  const mirror = (get, set, value) => {
    if (get() !== value) set(value)
  }
  function syncFromController() {
    mirror(derived, setDerived, state.derived)
    mirror(overlay, setOverlay, state.overlay)
    mirror(streaming, setStreaming, state.streaming)
    mirror(turnPhase, setTurnPhase, state.turnPhase)
    mirror(busy, setBusy, state.busy)
    mirror(compacting, setCompacting, state.compacting)
    mirror(compactStatus, setCompactStatus, state.compactStatus)
    mirror(startedAt, setStartedAt, state.startedAt)
    mirror(model, setModel, state.model)
    mirror(defaultModel, setDefaultModel, state.defaultModel)
    mirror(effort, setEffort, state.effort)
    mirror(defaultEffort, setDefaultEffort, state.defaultEffort)
    mirror(questionRequest, setQuestionRequest, state.question)
    mirror(queued, setQueued, state.queued)
    mirror(expedited, setExpedited, state.expedited)
    mirror(sent, setSent, state.sent)
    mirror(agentsVersion, setAgentsVersion, state.activityVersion)
  }

  // trend re-runs this component on every signal change, so the controller
  // is subscribed once and each handler reaches the newest render through
  // refs.ui, which is replaced below on every pass
  refs.ui = {
    sync: syncFromController,
    flash: (message) => flash(message),
    derived: (next) => {
      setAccent(next.color)
      boot.setTheme?.({ accent: next.color || DEFAULT_ACCENT, muted: MUTED })
    },
    question: () => fm.focus('question'),
    turn: () => {
      setFollow(true)
      setHistWindow(HISTORY_WINDOW)
    },
    input: (text) => setInput(text),
    session: () => {
      setViewedAgentId(null)
      setViewedShellId(null)
      setHistWindow(HISTORY_WINDOW)
      setFollow(true)
      fm.focus('input')
    },
    resumed: (meta) => flash(`resumed · ${meta.turns} ${meta.turns === 1 ? 'turn' : 'turns'} · ${timeAgo(meta.at)}`),
    project: (next) => {
      process.stdout.write(`\x1b]0;pico · ${next.root.split('/').pop()}\x07`)
      setMcpServers(next.mcp.list())
      setFileList([])
    },
    mcp: (servers) => setMcpServers(servers),
    shells: () => setShellsVersion((v) => v + 1),
    git: () => setGitVersion((v) => v + 1),
  }
  if (!refs.subscribed) {
    refs.subscribed = true
    ctl.on('change', () => refs.ui.sync())
    for (const type of ['flash', 'derived', 'question', 'turn', 'input', 'session', 'resumed', 'project', 'mcp', 'shells', 'git']) {
      ctl.on(type, (payload) => refs.ui[type](payload))
    }
  }
  syncFromController()

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

  const performCompaction = ctl.compact

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
    if (viewedAgentId() || viewedShellId()) return
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
    setHistIdx(-1)
    ctl.send(value)
  }

  function interrupt() {
    if (!busy()) return
    if (state.question) refs.focusComposerAfterQuestion = true
    ctl.interrupt()
  }

  const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  async function refreshMemories() {
    setMemoryList(await boot.memory.list().catch(() => []))
  }

  async function toggleMemoryDisabled(m) {
    try {
      await boot.memory.setDisabled(m, !m.disabled)
      await refreshMemories()
      flash(`${m.disabled ? 'enabled' : 'suppressed'} ${m.name} (${m.scope})`)
    } catch (err) {
      flash(`memory update failed: ${String(err.message || err).slice(0, 100)}`)
    }
  }

  async function forgetMemory(m) {
    const armed = refs.forgetArm
    if (!armed || armed.file !== m.file || Date.now() - armed.at > 3000) {
      refs.forgetArm = { file: m.file, at: Date.now() }
      return flash(`ctrl+x again to forget "${m.name}"`)
    }
    refs.forgetArm = null
    try {
      await boot.memory.forget(m)
      await refreshMemories()
      flash(`forgot ${m.name} (${m.scope})`)
    } catch (err) {
      flash(`forget failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function openContextPanel() {
    const tok = (n) => `~${fmtTokens(n)} tok`
    const breakdown = await ctl.contextBreakdown()
    const rows = breakdown.rows.map((row) => ({ name: row.name, desc: row.desc, note: tok(row.tokens) }))
    if (breakdown.measured) {
      rows.push({
        name: 'last measured request',
        desc: 'provider-reported input tokens, the number behind ctx %',
        note: `${breakdown.measured.toLocaleString()} tok`,
      })
    }
    setInfoPanel({
      title: `Context · ${breakdown.model}`,
      rows,
      overview: breakdown.segments.length ? { segments: breakdown.segments } : null,
    })
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

  function steerPreview() {
    return ctl.previewSteer(steer()?.changes)
  }

  function steerRows() {
    return steerableTranscript(steerPreview().transcript)
  }

  function beginSteer() {
    if (busy() || compacting()) return flash('finish or interrupt the current turn first')
    const rows = steerRows()
    const selected = Math.max(0, rows.length - 1)
    setSteer({ selected, editing: false, adding: false, role: 'user', changes: [] })
    if (rows[selected]) steerListFocus.focus(rows[selected].messageId)
    setHistWindow(Infinity)
    setFollow(true)
    fm.focus('steer')
  }

  function closeSteer(applied = false) {
    setSteer(null)
    setSteerText('')
    setHistWindow(HISTORY_WINDOW)
    fm.focus('input')
    if (applied) flash('conversation steering applied · nothing sent')
  }

  function applySteer() {
    const draft = steer()
    if (!draft?.changes.length) return closeSteer()
    ctl.applySteer(draft.changes)
    closeSteer(true)
  }

  function startSteerEdit() {
    const draft = steer()
    const row = steerRows()[draft.selected]
    if (!row) return startSteerAdd()
    if (row.locked) return flash('locked · this message is before the latest compaction')
    setSteerText(row.text)
    setSteer({ ...draft, editing: true, adding: false, role: row.role })
  }

  function startSteerAdd() {
    const draft = steer()
    const rows = steerRows()
    const selected = rows[draft.selected]
    const previousRole = selected?.role
    const role = previousRole === 'user' ? 'assistant' : STEER_ROLES[0]
    setSteerText('')
    setSteer({ ...draft, editing: true, adding: true, role })
  }

  function stageSteerText(text) {
    const value = text.trim()
    const draft = steer()
    if (!value) return flash('message cannot be empty')
    const rows = steerRows()
    const target = rows[draft.selected]
    const change = draft.adding
      ? { op: 'insert', id: makeEvent('message').id, after: target?.messageId ?? null, message: { role: draft.role, content: value } }
      : { op: 'replace', target: target.messageId, message: { role: draft.role, content: value } }
    setSteer({ ...draft, editing: false, adding: false, changes: [...draft.changes, change] })
    setSteerText('')
  }

  function stageSteerDelete() {
    const draft = steer()
    const rows = steerRows()
    const target = rows[draft.selected]
    if (!target) return
    if (target.locked) return flash('locked · this message is before the latest compaction')
    const changes = [...draft.changes, { op: 'delete', target: target.messageId }]
    const remaining = rows.filter((row) => row.messageId !== target.messageId)
    const selected = Math.min(draft.selected, Math.max(0, remaining.length - 1))
    setSteer({ ...draft, selected, changes })
    if (remaining[selected]) steerListFocus.focus(remaining[selected].messageId)
  }

  async function runCommand(c, args = '') {
    if (typeof args !== 'string') args = ''
    setInput('')
    setCmdCycle(null)
    if (c.name === 'fork') return ctl.fork(args.trim())
    if (c.name === 'rename') return ctl.rename(args)
    if (c.name === 'color') return ctl.setColor(args)
    if (c.name === 'config') {
      setShowConfigPanel(true)
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
    if (c.skill) return ctl.sendSkill(c.name)
    if (c.command) return ctl.sendCommand(c.name, args)
    if (c.name === 'connect') return openConnectPanel()
    if (c.name === 'init') return ctl.sendInit(args)
    if (c.name === 'parallel') {
      const task = args.trim()
      if (ctl.sendParallel(task)) return
      setPendingResearch({ task })
      setShowResearchModelPanel(true)
      return
    }
    if (c.name === 'deliberate') {
      const decision = args.trim()
      if (ctl.sendDeliberate(decision)) return
      setPendingDeliberation({ decision })
      setSelectingDeliberationModel(true)
      setShowResearchModelPanel(true)
      return
    }
    if (c.name === 'model') {
      if (!args) return setShowModelPanel(true)
      return ctl.switchModelByName(args)
    }
    if (c.name === 'effort') {
      if (!effortApplies()) return flash(`${model().name} does not support effort control`)
      if (!args) return setShowEffortPanel(true)
      return ctl.setEffortByName(args.toLowerCase())
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
    if (c.name === 'steer') return beginSteer()
    if (c.name === 'context') return openContextPanel()
    if (c.name === 'history') return openHistorySearch()
    if (c.name === 'help') return setView('help')
    if (c.name === 'mcp') return setShowMcpPanel(true)
    if (c.name === 'wakeups') return setShowWakeupsPanel(true)
    if (c.name === 'memory') {
      await refreshMemories()
      return setShowMemoryPanel(true)
    }
    if (c.name === 'resume') {
      if (busy()) return flash('finish or interrupt the current turn before switching sessions')
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
      const { rows, mcpCount } = await ctl.describeTools()
      setInfoPanel({ title: `Tools${mcpCount ? ` · plus ${mcpCount} MCP (see /mcp)` : ''}`, rows })
      return
    }
    if (c.name === 'new') return ctl.newSession()
    if (c.name === 'delete') {
      if (busy()) return flash('finish or interrupt the current turn first')
      if (!state.session) return flash('no current session to delete')
      setShowDeleteConfirm(true)
      return
    }
    if (c.name === 'rewind') {
      if (busy()) return flash('finish or interrupt the current turn first')
      if (userEntries(derived()).length === 0) return flash('nothing to rewind yet')
      setRewindStep('pick')
      return
    }
    if (c.name === 'clear') return ctl.clear()
    if (c.name === 'compact') return performCompaction(args)
    if (c.name === 'cost') {
      const cost = ctl.costSummary()
      if (!cost) return flash('no usage yet')
      const base = `$${cost.spent.toFixed(4)} spent · ${cost.promptTokens.toLocaleString()} in · ${cost.completionTokens.toLocaleString()} out`
      flash(cost.spent - cost.active > 0.00005 ? `${base} · current conversation $${cost.active.toFixed(4)}` : base)
      return
    }
    if (c.name === 'export') {
      const file = await ctl.exportMarkdown()
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
    ctl.connectProvider()
      .then(({ email, count }) => flash(`connected as ${email || 'your ChatGPT account'} · ${count} codex models unlocked in /model`))
      .catch((err) => flash(`connect failed: ${String(err.message || err).slice(0, 120)}`))
  }

  async function disconnectProvider(provider) {
    if (provider.id !== 'openai') return
    const armed = refs.disconnectArm
    if (!armed || armed.id !== provider.id || Date.now() - armed.at > 3000) {
      refs.disconnectArm = { id: provider.id, at: Date.now() }
      return flash(`ctrl+x again to disconnect ${provider.label} (you will need to sign in again)`)
    }
    refs.disconnectArm = null
    await ctl.disconnectProvider()
    refreshAuthProviders()
    flash('disconnected from ChatGPT')
  }

  function refreshSessions(scopeIndex) {
    setResumeLoading(true)
    listSessions({ scope: RESUME_SCOPES[scopeIndex], root })
      .then(setResumeSessions)
      .finally(() => setResumeLoading(false))
  }

  function shortenPath(path) {
    const home = homedir()
    return path.startsWith(home) ? path.replace(home, '~') : path
  }

  function openProjectPanel() {
    if (busy()) return flash('finish or interrupt the current turn before switching sessions')
    setShowProjectPanel(true)
    setProjectsLoading(true)
    ctl.listProjects()
      .then((list) => setProjects(list.map((p) => ({ ...p, path: shortenPath(p.root) }))))
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

  async function deleteSessionMeta(meta) {
    const current = state.session?.id === meta.header.id
    if (current && busy()) return flash('finish or interrupt the current turn first')
    const armed = refs.deleteArm
    if (!armed || armed.file !== meta.file || Date.now() - armed.at > 3000) {
      refs.deleteArm = { file: meta.file, at: Date.now() }
      return flash(`ctrl+x again to delete "${meta.title.slice(0, 50)}"`)
    }
    refs.deleteArm = null
    if (current) {
      if (await confirmDeleteCurrentSession()) refreshSessions(resumeScope())
      return
    }
    try {
      await deleteSession(meta.file)
      refreshSessions(resumeScope())
      flash('session deleted')
    } catch (err) {
      flash(`delete failed: ${String(err.message || err).slice(0, 80)}`)
    }
  }

  async function resumeSession(meta) {
    if (busy()) return flash('finish or interrupt the current turn before switching sessions')
    setShowResumePanel(false)
    setShowProjectPanel(false)
    await ctl.resume(meta)
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

  async function performRewindTo(target, opt) {
    await ctl.rewind(target, opt.key)
    setRewindStep(null)
    setRewindTarget(null)
  }

  function performRewind(opt) {
    return performRewindTo(rewindTarget(), opt)
  }

  const undoRewind = ctl.undoRewind

  async function confirmDeleteCurrentSession() {
    const deleted = await ctl.deleteCurrentSession()
    setShowDeleteConfirm(false)
    return deleted
  }

  const anyPanel = () =>
    showModelPanel() || showResearchModelPanel() || showEffortPanel() || showThemePanel() || showConfigPanel() || showDeleteConfirm() || showMemoryPanel() || showHistoryPanel() || showResumePanel() || showMcpPanel() ||
    showProjectPanel() || showWakeupsPanel() || showConnectPanel() ||
    infoPanel() !== null || rewindStep() !== null

  // every focus-taking panel dims the conversation behind it; the theme
  // picker is the one exemption, since its job is previewing palettes on
  // the undimmed ui
  const dimmingPanel = () => anyPanel() && !showThemePanel()

  function cancelAgent(agent) {
    ctl.cancelAgent(agent.id)
  }

  function dismissAgent(agent) {
    if (!ctl.dismissAgent(agent.id)) return
    if (viewedAgentId() === agent.id) setViewedAgentId(null)
  }

  function stopOrDismissDeliberation(item) {
    if (item.status === 'running') {
      interrupt()
      return
    }
    ctl.dismissDeliberation(item.deliberationId)
    if (viewedAgentId() === item.id) setViewedAgentId(null)
  }

  function dismissShell(shell) {
    boot.shells.dismiss(shell.id)
    if (viewedShellId() === shell.id) setViewedShellId(null)
  }

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

  const effortApplies = ctl.effortApplies
  const setSessionEffort = ctl.setEffort

  const fm = useFocus({ initial: 'input' })
  const steerListFocus = useFocus({ initial: null, cycle: 'none', active: false })
  fm.item('feed')
  if (steer()) {
    fm.item('steer')
    if (!fm.is('steer')) fm.focus('steer')
  }
  const conversationSearch = createConversationSearch({ fm, verbose, setFollow, setOffset })
  conversationSearch.registerFocus()
  let conversationSearchMatches = []
  agentsVersion()
  const agentRows = ctl.activity()
  shellsVersion()
  const shellRows = ctl.shellRows()
  if (questionRequest()) {
    fm.item('question')
    if (!fm.is('question')) fm.focus('question')
  } else {
    if (!viewedAgentId() && !viewedShellId()) fm.item('input')
    if (shellRows.length > 0 && agentRows.length > 0) {
      fm.group('activity-strip', { items: ['activity-main', ...shellRows.map((s) => `shell-${s.id}`), ...agentRows.map((a) => `agent-${a.id}`)], navigate: 'both', wrap: true })
    } else {
      if (shellRows.length > 0) fm.group('shell-strip', { items: ['shell-main', ...shellRows.map((s) => `shell-${s.id}`)], navigate: 'both', wrap: true })
      if (agentRows.length > 0) fm.group('agent-strip', { items: ['agent-main', ...agentRows.map((a) => `agent-${a.id}`)], navigate: 'both', wrap: true })
    }
    if (refs.focusComposerAfterQuestion && !viewedAgentId() && !viewedShellId()) {
      refs.focusComposerAfterQuestion = false
      fm.focus('input')
    }
  }
  useFocusTrap(anyPanel() || view() === 'help')
  useSelection({
    onCopy: (text) => flash(`copied ${text.length} ${text.length === 1 ? 'character' : 'characters'}`),
  })

  function navigateActivityStrip(event) {
    const items = ['activity-main', ...shellRows.map((shell) => `shell-${shell.id}`), ...agentRows.map((agent) => `agent-${agent.id}`)]
    const current = items.indexOf(fm.current())
    let next = current
    if (!event.ctrl && event.key === 'g') next = 0
    else if (!event.ctrl && event.key === 'G') next = items.length - 1
    else if (event.ctrl && event.key === 'd') next = Math.min(items.length - 1, current + Math.max(1, Math.floor(AGENT_STRIP_MAX / 2)))
    else if (event.ctrl && event.key === 'u') next = Math.max(0, current - Math.max(1, Math.floor(AGENT_STRIP_MAX / 2)))
    else if (event.key === 'j' || event.key === 'down') next = (current + 1 + items.length) % items.length
    else if (event.key === 'k' || event.key === 'up') next = (current - 1 + items.length) % items.length
    else return false
    const target = items[next]
    fm.focus(target)
    setViewedShellId(target.startsWith('shell-') ? target.slice('shell-'.length) : null)
    setViewedAgentId(target.startsWith('agent-') ? target.slice('agent-'.length) : null)
    setFollow(true)
    setHistWindow(HISTORY_WINDOW)
    event.stopPropagation()
    return true
  }

  function navigateStrip(event, prefix, rows, { main = false, previewAgent = false, previewShell = false } = {}) {
    const items = [...(main ? [`${prefix}-main`] : []), ...rows.map((row) => `${prefix}-${row.id}`)]
    const current = items.indexOf(fm.current())
    let next = current
    if (!event.ctrl && event.key === 'g') next = 0
    else if (!event.ctrl && event.key === 'G') next = items.length - 1
    else if (event.ctrl && event.key === 'd') next = Math.min(items.length - 1, current + Math.max(1, Math.floor(AGENT_STRIP_MAX / 2)))
    else if (event.ctrl && event.key === 'u') next = Math.max(0, current - Math.max(1, Math.floor(AGENT_STRIP_MAX / 2)))
    else if (event.key === 'j' || event.key === 'down') next = (current + 1 + items.length) % items.length
    else if (event.key === 'k' || event.key === 'up') next = (current - 1 + items.length) % items.length
    else return false
    const target = items[next]
    fm.focus(target)
    if (previewAgent) {
      setViewedAgentId(target === 'agent-main' ? null : target.slice('agent-'.length))
      setFollow(true)
      setHistWindow(HISTORY_WINDOW)
    }
    if (previewShell) {
      setViewedShellId(target === 'shell-main' ? null : target.slice('shell-'.length))
      setFollow(true)
    }
    event.stopPropagation()
    return true
  }

  useInput(async (event) => {
    if (steer() && fm.is('steer') && !steer().editing) {
      const draft = steer()
      const rows = steerRows()
      if (event.ctrl && event.key === 's') applySteer()
      else if (event.key === 'escape') closeSteer()
      else if (event.key === 'return') startSteerEdit()
      else if (event.key === 'a') startSteerAdd()
      else if (event.key === 'x' || event.key === 'd') stageSteerDelete()
      else if (event.key === 'up' || event.key === 'k') {
        const selected = Math.max(0, draft.selected - 1)
        steerListFocus.focus(rows[selected]?.messageId)
        setSteer({ ...draft, selected })
      } else if (event.key === 'down' || event.key === 'j') {
        const selected = Math.min(Math.max(0, rows.length - 1), draft.selected + 1)
        steerListFocus.focus(rows[selected]?.messageId)
        setSteer({ ...draft, selected })
      } else if (event.key === 'home' || event.key === 'g') {
        steerListFocus.focus(rows[0]?.messageId)
        setSteer({ ...draft, selected: 0 })
      } else if (event.key === 'end' || event.key === 'G') {
        const selected = Math.max(0, rows.length - 1)
        steerListFocus.focus(rows[selected]?.messageId)
        setSteer({ ...draft, selected })
      }
      else return
      event.stopPropagation()
      return
    }
    if (conversationSearch.handleInput(event, conversationSearchMatches)) return
    if (fm.is('activity-strip') && navigateActivityStrip(event)) return
    if (fm.is('activity-strip') && event.key === 'return') {
      const target = fm.current()
      setViewedShellId(target.startsWith('shell-') ? target.slice('shell-'.length) : null)
      setViewedAgentId(target.startsWith('agent-') ? target.slice('agent-'.length) : null)
      setFollow(true)
      setHistWindow(HISTORY_WINDOW)
      event.stopPropagation()
      return
    }
    if (fm.is('activity-strip') && event.ctrl && event.key === 'x') {
      const target = fm.current()
      const shell = target.startsWith('shell-') ? shellRows.find((s) => `shell-${s.id}` === target) : null
      const item = target.startsWith('agent-') ? agentRows.find((row) => `agent-${row.id}` === target) : null
      const agent = item?.role === 'deliberation' ? null : item
      if (shell) shell.status === 'running' ? killShell(shell) : dismissShell(shell)
      if (item?.role === 'deliberation') stopOrDismissDeliberation(item)
      else if (agent) ['queued', 'running'].includes(agent.status) ? cancelAgent(agent) : dismissAgent(agent)
      event.stopPropagation()
      return
    }
    if (fm.is('shell-strip') && navigateStrip(event, 'shell', shellRows, { main: true, previewShell: true })) return
    if (fm.is('agent-strip') && navigateStrip(event, 'agent', agentRows, { main: true, previewAgent: true })) return
    if (fm.is('shell-strip') && event.key === 'return') {
      const target = fm.current()
      setViewedShellId(target === 'shell-main' ? null : target.slice('shell-'.length))
      setFollow(true)
      event.stopPropagation()
      return
    }
    if (fm.is('shell-strip') && event.ctrl && event.key === 'x') {
      const shell = fm.current() === 'shell-main' ? null : shellRows.find((s) => `shell-${s.id}` === fm.current())
      if (shell) {
        if (shell.status === 'running') killShell(shell)
        else dismissShell(shell)
      }
      event.stopPropagation()
      return
    }
    if (fm.is('agent-strip') && event.key === 'return') {
      const target = fm.current()
      setViewedAgentId(target === 'agent-main' ? null : target.slice('agent-'.length))
      setFollow(true)
      setHistWindow(HISTORY_WINDOW)
      event.stopPropagation()
      return
    }
    if (fm.is('agent-strip') && event.ctrl && event.key === 'x') {
      const target = fm.current()
      const item = target === 'agent-main' ? null : agentRows.find((row) => `agent-${row.id}` === target)
      if (item?.role === 'deliberation') stopOrDismissDeliberation(item)
      else if (item) {
        if (['queued', 'running'].includes(item.status)) cancelAgent(item)
        else dismissAgent(item)
      }
      event.stopPropagation()
      return
    }
    if (event.key === 'escape' && busy() && !anyPanel()) {
      interrupt()
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'c') {
      const now = Date.now()
      if (now - refs.quitAt < 1500) {
        await ctl.shutdown()
        process.exit(0)
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
    if (fm.is('feed') && event.key === '/') {
      conversationSearch.open()
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 'r' && view() === 'chat' && !anyPanel()) {
      if (busy()) flash('finish or interrupt the current turn first')
      else if (userEntries(derived()).length === 0) flash('nothing to rewind yet')
      else setRewindStep('pick')
      event.stopPropagation()
      return
    }
    if (event.ctrl && event.key === 's' && view() === 'chat' && !anyPanel()) {
      if (busy()) flash('finish or interrupt the current turn before switching sessions')
      else {
        setShowResumePanel(true)
        refreshSessions(resumeScope())
      }
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
    if (event.ctrl && event.key === 'z' && state.rewindUndo && !busy() && view() === 'chat') {
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
    const placeholder = ctl.attachProjectFile(f)
    if (placeholder) {
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
  const contextPercent = model().context > 0 && derived().lastPromptTokens > 0 && derived().lastPromptModel === model().name
    ? Math.min(100, Math.round((derived().lastPromptTokens / model().context) * 100))
    : 0
  const visibleShells = shellRows
  const viewedShell = viewedShellId() ? visibleShells.find((s) => s.id === viewedShellId()) : null
  const combinedActivity = visibleShells.length > 0 && agentRows.length > 0
  const shellStripFocus = fm.is('shell-strip') || (fm.is('activity-strip') && fm.current().startsWith('shell-')) ? fm.current() : null
  const focusedShellId = shellStripFocus && shellStripFocus !== 'shell-main' ? shellStripFocus.slice('shell-'.length) : null
  const focusedShell = focusedShellId ? visibleShells.find((s) => s.id === focusedShellId) : null
  const hintedShell = focusedShell || viewedShell
  const shellActionHint = hintedShell ? `ctrl+x ${hintedShell.status === 'running' ? 'kill' : 'dismiss'}` : ''
  const shellWindowTarget = shellStripFocus === 'shell-main' ? 0 : visibleShells.findIndex((s) => s.id === (focusedShellId || viewedShellId()))
  const shellWindowStart = stripWindowStart(shellWindowOffset(), shellWindowTarget, visibleShells.length, SHELL_STRIP_MAX)
  if (shellWindowStart !== shellWindowOffset()) setShellWindowOffset(shellWindowStart)
  const shellWindow = visibleShells.slice(shellWindowStart, shellWindowStart + SHELL_STRIP_MAX)
  agentsVersion()
  const visibleAgents = agentRows
  const viewedAgent = viewedAgentId() ? agentRows.find((row) => row.id === viewedAgentId()) : null
  const agentStripFocus = fm.is('agent-strip') || (fm.is('activity-strip') && fm.current().startsWith('agent-')) ? fm.current() : null
  const focusedAgentId = agentStripFocus && agentStripFocus !== 'agent-main' ? agentStripFocus.slice('agent-'.length) : null
  const focusedAgent = focusedAgentId ? agentRows.find((row) => row.id === focusedAgentId) : null
  const hintedAgent = focusedAgent || viewedAgent
  const agentActionHint = hintedAgent
    ? `ctrl+x ${['queued', 'running'].includes(hintedAgent.status) ? 'cancel' : 'dismiss'}`
    : ''
  const agentWindowTarget = agentStripFocus === 'agent-main'
    ? 0
    : visibleAgents.findIndex((a) => a.id === (focusedAgentId || viewedAgentId()))
  const agentWindowStart = stripWindowStart(agentWindowOffset(), agentWindowTarget, visibleAgents.length, AGENT_STRIP_MAX)
  if (agentWindowStart !== agentWindowOffset()) setAgentWindowOffset(agentWindowStart)
  const agentWindow = visibleAgents.slice(agentWindowStart, agentWindowStart + AGENT_STRIP_MAX)
  const pendingWakeups = boot.wakeups.pending()
  gitVersion()
  const gitInfo = gitFooter() ? boot.git.status() : null

  if (view() === 'help') {
    return <Help commands={COMMANDS} onClose={() => setView('chat')} />
  }

  highlightVersion()

  const mainTranscript = steer() ? steerPreview().transcript : derived().transcript
  const selectedSteerMessageId = steerRows()[steer()?.selected]?.messageId
  const decoratedTranscript = steer() ? mainTranscript.map((item) => ({
    ...item,
    steerSelected: item.messageId === selectedSteerMessageId,
  })) : mainTranscript
  const activeShell = shellStripFocus ? focusedShell : agentStripFocus ? null : viewedShell
  const activeAgent = agentStripFocus ? focusedAgent : shellStripFocus ? null : viewedAgent
  let shellOutput = null
  if (activeShell) {
    try { shellOutput = boot.shells.output(activeShell.id, { tail: 2000 }) } catch {}
  }
  const shellTranscript = activeShell ? [
    { kind: 'shell-command', text: activeShell.command },
    { kind: 'shell-output', text: shellOutput?.output || 'no output yet' },
  ] : null
  const transcriptSource = activeShell ? `shell:${activeShell.id}` : activeAgent ? `agent:${activeAgent.id}` : 'main'
  const transcript = shellTranscript || (activeAgent ? agentTranscript(activeAgent) : decoratedTranscript)
  const hiddenCount = Math.max(0, transcript.length - histWindow())
  const isolatedTranscript = activeAgent || activeShell
  const visibleItems = isolatedTranscript ? transcript.slice(hiddenCount) : [...transcript.slice(hiddenCount), ...overlay()]
  const groupedItems = steer()
    ? collapseSteerTools(visibleItems)
    : compactToolHistory()
      ? compactTranscriptRuns(visibleItems, activeAgent ? activeAgent.status === 'running' : activeShell ? false : turnPhase() === 'tools')
      : visibleItems
  const preparedConversation = conversationSearch.prepare(groupedItems)
  conversationSearchMatches = preparedConversation.matches
  const items = preparedConversation.items

  const wideLayout = wideSidebar() && terminalWidth() > 160

  if (showMemoryPanel()) {
    return (
      <MemoryPanel
        memories={memoryList().filter((m) => MEMORY_SCOPES[memScope()] === 'all' || m.scope === MEMORY_SCOPES[memScope()])}
        scopes={MEMORY_SCOPES}
        scopeIndex={memScope()}
        focused
        onToggleDisabled={toggleMemoryDisabled}
        onForget={forgetMemory}
        onClose={() => setShowMemoryPanel(false)}
      />
    )
  }

  if (showResumePanel()) {
    return (
      <ResumePanel
        sessions={resumeSessions()}
        scopes={RESUME_SCOPES}
        scopeIndex={resumeScope()}
        loading={resumeLoading()}
        focused
        currentId={state.session?.id}
        onPick={(meta) => {
          if (meta.header.id === state.session?.id) return setShowResumePanel(false)
          resumeSession(meta)
        }}
        onDelete={deleteSessionMeta}
        onClose={() => setShowResumePanel(false)}
      />
    )
  }

  if (showProjectPanel()) {
    return (
      <ProjectPanel
        projects={projects()}
        loading={projectsLoading()}
        focused
        onPick={(p) => resumeSession(p.latest)}
        onDelete={deleteProject}
        onClose={() => setShowProjectPanel(false)}
      />
    )
  }

  if (showConfigPanel()) {
    return (
      <ConfigPanel
        values={{ clouds: clouds(), compactTools: compactToolHistory(), gitStatus: gitFooter(), wideSidebar: wideSidebar(), researchModel: boot.researchModel, deliberationModel: boot.deliberationModel, researchAgentLimit: researchAgentLimit() }}
        focused
        onPickResearchModel={() => {
          setSelectingDeliberationModel(false)
          setResearchModelReturn('config')
          setShowConfigPanel(false)
          setShowResearchModelPanel(true)
        }}
        onPickDeliberationModel={() => {
          setSelectingDeliberationModel(true)
          setResearchModelReturn('config')
          setShowConfigPanel(false)
          setShowResearchModelPanel(true)
        }}
        onChange={(name, value) => {
          if (name === 'clouds') {
            setClouds(value)
            writeConfig({ animation: { clouds: value } })
          } else if (name === 'gitStatus') {
            setGitFooter(value)
            boot.gitFooter = value
            boot.git.setEnabled(value)
            writeConfig({ display: { gitStatus: value } })
          } else if (name === 'wideSidebar') {
            setWideSidebar(value)
            boot.wideSidebar = value
            writeConfig({ display: { wideSidebar: value } })
          } else if (name === 'researchAgentLimit') {
            setResearchAgentLimit(value)
            boot.researchAgentLimit = value
            writeConfig({ research: { agentLimit: value } })
          } else {
            setCompactToolHistory(value)
            writeConfig({ display: { compactToolHistory: value } })
          }
        }}
        onClose={() => setShowConfigPanel(false)}
      />
    )
  }

  return (
    <box style={{ flexDirection: wideLayout ? 'row' : 'column', height: '100%' }}>
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {transcript.length === 0 ? (
        <box style={{ flexGrow: 1, dim: dimmingPanel() }}>
          <EmptyState version={version} clouds={clouds()} />
        </box>
      ) : <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <ScrollBox
          style={{ flexGrow: 1, dim: dimmingPanel() }}
          focused={fm.is('feed') || fm.is('conversation-search')}
          followFocus={steer() ? steerListFocus : null}
          focusPadding={1}
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
        <ConversationScrollAnchor target={conversationSearch.scroll} />
        {hiddenCount > 0 && (
          <box style={{ paddingX: 2 }}>
            <text style={{ color: FAINT, italic: true }}>{`⌃ ${hiddenCount.toLocaleString()} older ${hiddenCount === 1 ? 'message' : 'messages'} · scroll to top to load`}</text>
          </box>
        )}
        {items.map((item, i) => steer() && item.messageId ? (
          <SteerMessage
            key={`${transcriptSource}:${item.messageId || item.callId || hiddenCount + i}`}
            item={item}
            verbose={verbose()}
            selected={item.messageId === selectedSteerMessageId}
            focus={steerListFocus}
          />
        ) : (
          <ConversationSearchMessage
            key={`${transcriptSource}:${item.messageId || item.callId || hiddenCount + i}`}
            item={item}
            verbose={verbose()}
            currentMatch={conversationSearchMatches[conversationSearch.index()]?.itemIndex === i ? conversationSearchMatches[conversationSearch.index()] : null}
            search={conversationSearch}
          />
        ))}
          {!isolatedTranscript && streaming() !== null && streaming() !== '' && (
            <Message key="streaming" item={{ kind: 'assistant', text: `${streaming()}▋` }} />
          )}
        </ScrollBox>
        {conversationSearch.active() ? (
          <ConversationSearchBar search={conversationSearch} matches={conversationSearchMatches} />
        ) : fm.is('feed') && !anyPanel() && (
          <box style={{ position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', bg: accent(), paddingX: 2 }}>
            <box style={{ flexGrow: 1 }} />
            <text style={{ color: 'black' }}>{'j/k · ↑/↓ scroll   g/G ends   / search   ctrl-u/d page'}</text>
          </box>
        )}
      </box>}

      {(expedited().length > 0 || queued().length > 0) && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          {expedited().map((message, i) => (
            <box key={`expedited-${i}`} style={{ flexDirection: 'row' }}>
              <text style={{ color: accent(), bold: true }}>{'↠ '}</text>
              <box style={{ flexGrow: 1, height: 1 }}>
                <text style={{ overflow: 'truncate', color: accent() }}>{message.replace(/\n/g, ' ')}</text>
              </box>
              {i === 0 && <text style={{ color: accent() }}>{'  after next tool · ↑ to edit'}</text>}
            </box>
          ))}
          {queued().map((message, i) => (
            <box key={`pending-${i}`} style={{ flexDirection: 'row' }}>
              <text style={{ color: FAINT }}>{'› '}</text>
              <box style={{ flexGrow: 1, height: 1 }}>
                <text style={{ overflow: 'truncate', color: MUTED }}>{message.replace(/\n/g, ' ')}</text>
              </box>
              {i === 0 && expedited().length === 0 && <text style={{ color: MUTED }}>{'  pending · ↑ edit · → send after next tool'}</text>}
            </box>
          ))}
        </box>
      )}

      {questionRequest() && (
        <QuestionForm
          request={questionRequest()}
          focused={fm.is('question') && !anyPanel()}
          onSubmit={(answers) => {
            refs.focusComposerAfterQuestion = true
            ctl.answerQuestion(answers)
          }}
          onCancel={() => {
            refs.focusComposerAfterQuestion = true
            ctl.cancelQuestion()
          }}
        />
      )}

      {steer() && (
        <box style={{ flexDirection: 'column', bg: PANEL_BG, paddingX: 2, paddingY: 1, marginTop: 1 }}>
          <text style={{ color: accent(), bold: true }}>{steer().editing ? `${steer().adding ? 'Add' : 'Edit'} ${steer().role}` : `Steer · ${steer().changes.length} staged`}</text>
          {steer().editing ? (
            <TextArea
              focused={fm.is('steer')}
              value={steerText()}
              onChange={setSteerText}
              onSubmit={stageSteerText}
              onCancel={() => {
                setSteerText('')
                setSteer({ ...steer(), editing: false, adding: false })
              }}
              onKeyDown={(event) => {
                if (event.key === 'tab') {
                  const at = STEER_ROLES.indexOf(steer().role)
                  setSteer({ ...steer(), role: STEER_ROLES[(at + 1) % STEER_ROLES.length] })
                  return true
                }
                return false
              }}
              submitOnEnter
              newlineOnBackslashEnter
              clearOnSubmit
              maxHeight={8}
              cursor={{ blink: true, bg: accent(), color: 'black' }}
            />
          ) : (
            <text style={{ color: MUTED }}>{'↑↓ select · enter edit · a add after · x/d delete · ctrl+s apply · esc discard'}</text>
          )}
        </box>
      )}

      {!steer() && !viewedAgent && !viewedShell && <MouseFocusRegion onPress={() => fm.focus('input')} style={{ bg: PANEL_BG, flexDirection: 'row', paddingX: 2, paddingY: 1, marginTop: transcript.length === 0 && clouds() ? 0 : 1, dim: dimmingPanel() || !!questionRequest() }}>
        <text style={{ color: fm.is('input') && !anyPanel() && !questionRequest() ? accent() : MUTED, bold: true }}>{'❯'}</text>
        <text> </text>
        {(state.session?.header.forkedFrom || derived().title) && (
          <box style={{ position: 'absolute', top: 0, right: 0, flexDirection: 'row' }}>
            {state.session?.header.forkedFrom && <text style={{ color: MUTED }}>{derived().title ? '⑂ ' : '⑂'}</text>}
            {derived().title && <text style={{ bg: fm.is('input') && !anyPanel() && !questionRequest() ? accent() : MUTED, color: 'black', bold: true }}>{` ${derived().title} `}</text>}
          </box>
        )}
        <TextArea
          color={FG}
          lineCounter
          scrollbar
          focused={fm.is('input') && !anyPanel() && !questionRequest()}
          value={input()}
          onChange={(v) => {
            const converted = placeholderizeImagePaths(v, {
              attachments: state.attachments,
              nextId: () => ++state.imageCount,
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
              const target = implicitRewindTarget(derived(), input())
              if (target) performRewindTo(target, { key: 'chat' })
              else {
                setCmdCycle(null)
                setCompleting(false)
                setFilesDismissed(true)
              }
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
                const placeholders = paths.map((path) => ctl.attachImage(path))
                const at = e.cursor ?? e.value.length
                setInput(e.value.slice(0, at) + placeholders.join(' ') + e.value.slice(at))
                return true
              }
              return false
            }
            if (e.key === 'backspace' && e.cursor > 0) {
              const match = e.value.slice(0, e.cursor).match(/\[Image #\d+\]$/)
              if (match) {
                ctl.detachImage(match[0])
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
            if (e.key === 'up' && e.value === '' && (expedited().length > 0 || queued().length > 0)) {
              setInput(ctl.recallPending())
              return true
            }
            if (e.key === 'right' && e.value === '' && queued().length > 0 && busy() && !compacting()) {
              ctl.expediteQueued()
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
          newlineOnBackslashEnter
          clearOnSubmit
          maxHeight={8}
          cursor={{ blink: true, bg: accent(), color: 'black' }}
        />
      </MouseFocusRegion>}

      {showCommands && (
        <box style={{ flexDirection: 'column', height: 6, minHeight: 6, paddingX: 2, marginTop: 1 }}>
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
        <box style={{ flexDirection: 'column', height: 6, minHeight: 6, paddingX: 2, marginTop: 1 }}>
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
        <box style={{ flexDirection: 'column', height: 6, minHeight: 6, paddingX: 2, marginTop: 1 }}>
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
      </box>

      <box style={{ flexDirection: 'column', width: wideLayout ? 64 : undefined, height: wideLayout ? '100%' : undefined }}>
      {showModelPanel() && (
        <ModelPanel
          models={models}
          current={model().name}
          defaultName={defaultModel().name}
          focused={showModelPanel()}
          onPick={(m) => {
            if (ctl.switchModel(m)) setShowModelPanel(false)
          }}
          onPickDefault={(m) => {
            if (ctl.switchModel(m, { asDefault: true })) setShowModelPanel(false)
          }}
          onClose={() => setShowModelPanel(false)}
        />
      )}

      {showResearchModelPanel() && (
        <ModelPanel
          models={models.filter((m) => m.available !== false)}
          current={selectingDeliberationModel() ? boot.deliberationModel : boot.researchModel}
          defaultName={null}
          title={selectingDeliberationModel() ? 'Choose deliberation model' : 'Choose parallel worker model'}
          hint="enter: save model · esc: cancel"
          focused={showResearchModelPanel()}
          onPick={(m) => {
            if (selectingDeliberationModel()) {
              boot.deliberationModel = m.name
              writeConfig({ models: { deliberation: m.name } }).catch(() => {})
              flash(`deliberation: ${m.name}`)
            } else {
              boot.researchModel = m.name
              writeConfig({ models: { researchWorker: m.name } }).catch(() => {})
              flash(`parallel workers: ${m.name}`)
            }
            setSelectingDeliberationModel(false)
            setShowResearchModelPanel(false)
            const pending = pendingResearch()
            const pendingDecision = pendingDeliberation()
            const returnTo = researchModelReturn()
            setPendingResearch(null)
            setPendingDeliberation(null)
            setResearchModelReturn(null)
            if (pending) runCommand({ name: 'parallel' }, pending.task)
            else if (pendingDecision) runCommand({ name: 'deliberate' }, pendingDecision.decision)
            else if (returnTo === 'config') setShowConfigPanel(true)
          }}
          onPickDefault={() => {}}
          onClose={() => {
            setShowResearchModelPanel(false)
            setSelectingDeliberationModel(false)
            setPendingResearch(null)
            setPendingDeliberation(null)
            if (researchModelReturn() === 'config') setShowConfigPanel(true)
            setResearchModelReturn(null)
          }}
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

      {showDeleteConfirm() && (
        <ConfirmPanel
          title="Delete current session?"
          message="The current conversation and its persisted history will be permanently deleted."
          confirmLabel="Delete"
          focused={showDeleteConfirm()}
          onConfirm={confirmDeleteCurrentSession}
          onClose={() => setShowDeleteConfirm(false)}
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

      {infoPanel() && (
        <InfoListPanel
          title={infoPanel().title}
          rows={infoPanel().rows}
          overview={infoPanel().overview}
          focused={infoPanel() !== null}
          onClose={() => setInfoPanel(null)}
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
            const armed = refs.wakeupCancelArm
            if (!armed || armed.id !== w.id || Date.now() - armed.at > 3000) {
              refs.wakeupCancelArm = { id: w.id, at: Date.now() }
              return flash(`again to cancel wake-up ${w.id} (${w.note.split('\n')[0].slice(0, 40)})`)
            }
            refs.wakeupCancelArm = null
            ctl.cancelWakeup(w)
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
          onRemove={(name) => {
            const armed = refs.mcpRemoveArm
            if (!armed || armed.name !== name || Date.now() - armed.at > 3000) {
              refs.mcpRemoveArm = { name, at: Date.now() }
              return flash(`ctrl+x again to remove "${name}" and its config`)
            }
            refs.mcpRemoveArm = null
            mcp.remove(name)
            flash(`removed mcp server ${name}`)
          }}
          onAdd={(name, command, scope) => {
            mcp.add(name, command, scope)
            flash(`added ${name} (${scope})`)
          }}
          onEdit={(name, command) => {
            mcp.update(name, command)
            flash(`updated ${name}`)
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

      {combinedActivity && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
          <AgentStripRow selected={!viewedShell && !viewedAgent} focused={fm.current() === 'activity-main'} onPress={() => { fm.focus('activity-main'); setViewedShellId(null); setViewedAgentId(null); setFollow(true); setHistWindow(HISTORY_WINDOW) }}>
            <text style={{ color: fm.current() === 'activity-main' ? 'black' : accent() }}>{'● '}</text>
            <text style={{ color: fm.current() === 'activity-main' ? 'black' : !viewedShell && !viewedAgent ? FG : MUTED }}>{'main'}</text>
          </AgentStripRow>
        </box>
      )}

      {visibleShells.length > 0 && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: combinedActivity ? 0 : 1 }}>
          <box style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <text style={{ color: MUTED }}>{`${shellActionHint ? `${shellActionHint} · ` : ''}j/k move`}</text>
          </box>
          {!combinedActivity && (
            <AgentStripRow selected={!viewedShell} focused={fm.current() === 'shell-main'} onPress={() => { fm.focus('shell-main'); setViewedShellId(null); setViewedAgentId(null); setFollow(true) }}>
              <text style={{ color: fm.current() === 'shell-main' ? 'black' : accent() }}>{'● '}</text>
              <text style={{ color: fm.current() === 'shell-main' ? 'black' : !viewedShell ? FG : MUTED }}>{'main'}</text>
            </AgentStripRow>
          )}
          {shellWindow.map((s) => {
            const focused = fm.current() === `shell-${s.id}`
            const selected = viewedShellId() === s.id
            const elapsed = agentElapsed({ startedAt: s.startedAt, endedAt: s.endedAt })
            return (
              <AgentStripRow key={`shell-${s.id}`} selected={selected} focused={focused} onPress={() => { fm.focus(`shell-${s.id}`); setViewedShellId(s.id); setViewedAgentId(null); setFollow(true) }}>
                {s.status === 'running' ? <Spinner color={focused ? 'black' : accent()} variant="dots" /> : <text style={{ color: focused ? 'black' : s.exitCode === 0 ? GREEN : RED }}>{s.exitCode === 0 ? '●' : '×'}</text>}
                <text>{' '}</text>
                <text style={{ color: focused ? 'black' : selected ? FG : MUTED }}>{`shell [${s.id}]  `}</text>
                <box style={{ flexGrow: 1, height: 1 }}>
                  <text style={{ overflow: 'truncate', color: focused ? 'black' : MUTED }}>{s.description || s.command.replace(/\n/g, ' ')}</text>
                </box>
                <text style={{ color: focused ? 'black' : MUTED }}>{`  ${s.status === 'running' ? '' : `exit ${s.exitCode} · `}${elapsed}`}</text>
              </AgentStripRow>
            )
          })}
          {visibleShells.length > SHELL_STRIP_MAX && (
            <text style={{ color: MUTED }}>{`  ${shellWindowStart > 0 ? `↑ ${shellWindowStart}` : ''}${shellWindowStart > 0 && shellWindowStart + shellWindow.length < visibleShells.length ? ' · ' : ''}${shellWindowStart + shellWindow.length < visibleShells.length ? `↓ ${visibleShells.length - shellWindowStart - shellWindow.length}` : ''} more`}</text>
          )}
        </box>
      )}

      {visibleAgents.length > 0 && (
        <box style={{ flexDirection: 'column', paddingX: 2, marginTop: combinedActivity ? 0 : 1 }}>
          <box style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <text style={{ color: MUTED }}>{`${agentActionHint ? `${agentActionHint} · ` : ''}j/k move`}</text>
          </box>
          {!combinedActivity && (
            <AgentStripRow selected={!viewedAgent} focused={fm.current() === 'agent-main'} onPress={() => { fm.focus('agent-main'); setViewedShellId(null); setViewedAgentId(null); setFollow(true); setHistWindow(HISTORY_WINDOW) }}>
              <text style={{ color: fm.current() === 'agent-main' ? 'black' : accent() }}>{'● '}</text>
              <text style={{ color: fm.current() === 'agent-main' ? 'black' : !viewedAgent ? FG : MUTED }}>{'main'}</text>
            </AgentStripRow>
          )}
          {agentWindow.map((a) => {
            const status = agentStatus(a)
            const focused = fm.current() === `agent-${a.id}`
            return (
              <AgentStripRow key={`agent-${a.id}`} selected={viewedAgentId() === a.id} focused={focused} onPress={() => { fm.focus(`agent-${a.id}`); setViewedShellId(null); setViewedAgentId(a.id); setFollow(true); setHistWindow(HISTORY_WINDOW) }}>
                {a.status === 'running' ? <Spinner color={focused ? 'black' : accent()} variant="dots" /> : <text style={{ color: focused ? 'black' : status.color }}>{status.icon}</text>}
                <text>{' '}</text>
                <text style={{ color: focused ? 'black' : viewedAgentId() === a.id ? FG : MUTED }}>{`${a.role || 'agent'} [${a.id}]  `}</text>
                <box style={{ flexGrow: 1, height: 1 }}>
                  <text style={{ overflow: 'truncate', color: focused ? 'black' : MUTED }}>{a.description}</text>
                </box>
                {status.label && <text style={{ color: focused ? 'black' : status.color }}>{`  ${status.label}`}</text>}
                <text style={{ color: focused ? 'black' : MUTED }}>{`${status.label ? ' ·' : '  '} ${agentElapsed(a)} · ↓ `}</text>
                <AnimatedValue value={a.usage?.totalTokens || a.usage?.promptTokens || 0} color={focused ? 'black' : MUTED} highlight={focused ? 'black' : accent()} format={(n) => `${compactNumber(n)} tokens`} />
              </AgentStripRow>
            )
          })}
          {visibleAgents.length > AGENT_STRIP_MAX && (
            <text style={{ color: MUTED }}>{`  ${agentWindowStart > 0 ? `↑ ${agentWindowStart}` : ''}${agentWindowStart > 0 && agentWindowStart + agentWindow.length < visibleAgents.length ? ' · ' : ''}${agentWindowStart + agentWindow.length < visibleAgents.length ? `↓ ${visibleAgents.length - agentWindowStart - agentWindow.length}` : ''} more`}</text>
          )}
        </box>
      )}

      {wideLayout && <box style={{ flexGrow: 1 }} />}

      {wideLayout ? (
        <box style={{ flexDirection: 'column', paddingX: 2, paddingTop: 1 }}>
          {busy() && (
            <box style={{ flexDirection: 'column', marginBottom: 1 }}>
              <box style={{ flexDirection: 'row' }}>
                <Shimmer color={accent()} highlight={HIGHLIGHT} duration={1500} reverse>
                  {compacting()
                    ? compactStatus()?.phase === 'writing' ? `Compacting · writing ${compactStatus().section}/8` : 'Compacting · analyzing'
                    : turnPhase() === 'thinking' ? 'Thinking' : turnPhase() === 'tools' ? 'Working' : 'Responding'}
                </Shimmer>
                <text style={{ color: FAINT }}>{` · ${elapsed} · esc to interrupt`}</text>
              </box>
              {compactStatus()?.phase === 'writing' && <ProgressBar variant="thin" value={compactStatus().section / 8} width={30} percentage={false} color={accent()} />}
            </box>
          )}
          {gitInfo?.branch && (
            <box style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text style={{ color: FG_SOFT, bold: true }}>{'Repository'}</text>
              <box style={{ flexDirection: 'row' }}>
                <text style={{ color: MUTED }}>{'Branch  '}</text>
                <text style={{ color: FG_SOFT, overflow: 'truncate' }}>{gitInfo.branch}</text>
              </box>
              <box style={{ flexDirection: 'row' }}>
                <text style={{ color: MUTED }}>{'Changes '}</text>
                {gitInfo.added > 0 && <text style={{ color: GREEN }}>{`${gitInfo.added} added`}</text>}
                {gitInfo.added > 0 && gitInfo.removed > 0 && <text style={{ color: MUTED }}>{' · '}</text>}
                {gitInfo.removed > 0 && <text style={{ color: RED }}>{`${gitInfo.removed} removed`}</text>}
                {gitInfo.added === 0 && gitInfo.removed === 0 && <text style={{ color: MUTED }}>{'clean'}</text>}
              </box>
            </box>
          )}
          <box style={{ flexDirection: 'column' }}>
            <text style={{ color: FG_SOFT, bold: true }}>{'Session'}</text>
            <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Directory      '}</text><text style={{ color: FG_SOFT, overflow: 'truncate' }}>{boot.displayCwd}</text></box>
            <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Model          '}</text><text style={{ color: accent() }}>{model().name}</text></box>
            {effortApplies() && effort() && <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Effort         '}</text><text style={{ color: FG_SOFT }}>{effort()}</text></box>}
            <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Input tokens   '}</text><AnimatedValue value={usage.promptTokens} color={FG_SOFT} highlight={accent()} format={(n) => Math.round(n).toLocaleString()} /></box>
            <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Output tokens  '}</text><AnimatedValue value={usage.completionTokens} color={FG_SOFT} highlight={accent()} format={(n) => Math.round(n).toLocaleString()} /></box>
            {usage.thoughtTokens > 0 && <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Thought tokens '}</text><AnimatedValue value={usage.thoughtTokens} color={FG_SOFT} highlight={accent()} format={(n) => Math.round(n).toLocaleString()} /></box>}
            {contextPercent > 0 && <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Context used   '}</text><AnimatedValue value={contextPercent} color={contextPercent >= 80 ? RED : FG_SOFT} highlight={accent()} format={(n) => `${Math.round(n)}%`} /></box>}
            {pendingWakeups > 0 && <box style={{ flexDirection: 'row' }}><text style={{ color: MUTED }}>{'Wake-ups       '}</text><text style={{ color: FG_SOFT }}>{pendingWakeups}</text></box>}
          </box>
        </box>
      ) : (
        <box style={{ flexDirection: 'column' }}>
          <box style={{ flexDirection: 'row', paddingX: 2, gap: 1, marginTop: 1 }}>
            <box style={{ flexGrow: 1, height: 1 }}>
              {busy()
                ? (
                  <box style={{ flexDirection: 'row' }}>
                    <Shimmer color={accent()} highlight={HIGHLIGHT} duration={1500} reverse>
                      {compacting()
                        ? compactStatus()?.phase === 'writing' ? `Compacting · writing ${compactStatus().section}/8` : 'Compacting · analyzing'
                        : turnPhase() === 'thinking' ? 'Thinking' : turnPhase() === 'tools' ? 'Working' : 'Responding'}
                    </Shimmer>
                    <text style={{ color: FAINT, overflow: 'truncate' }}>{` · ${elapsed} · esc to interrupt`}</text>
                  </box>
                )
                : <text style={{ color: MUTED, overflow: 'truncate' }}>{boot.displayCwd}</text>}
            </box>
            {gitInfo?.branch && <text style={{ color: MUTED, overflow: 'truncate' }}>{gitInfo.branch}</text>}
            {gitInfo?.added > 0 && <text style={{ color: GREEN }}>{`+${gitInfo.added}`}</text>}
            {gitInfo?.removed > 0 && <text style={{ color: RED }}>{`-${gitInfo.removed}`}</text>}
          </box>
          <box style={{ flexDirection: 'row', paddingX: 2, gap: 1 }}>
            <text style={{ color: MUTED }}>{model().name}</text>
            {effortApplies() && effort() && <text style={{ color: MUTED }}>{`· ${effort()}`}</text>}
            <box style={{ flexGrow: 1 }} />
            {pendingWakeups > 0 && <text style={{ color: MUTED }}>{`⏰ ${pendingWakeups}`}</text>}
            <AnimatedValue value={usage.promptTokens} color={MUTED} highlight={accent()} format={(n) => `${compactNumber(n)} input`} />
            <text style={{ color: MUTED }}>{'·'}</text>
            <AnimatedValue value={usage.completionTokens} color={MUTED} highlight={accent()} format={(n) => `${compactNumber(n)} output`} />
            {usage.thoughtTokens > 0 && <text style={{ color: MUTED }}>{'·'}</text>}
            {usage.thoughtTokens > 0 && <AnimatedValue value={usage.thoughtTokens} color={MUTED} highlight={accent()} format={(n) => `${compactNumber(n)} thought`} />}
            {contextPercent > 0 && <text style={{ color: MUTED }}>{'·'}</text>}
            {contextPercent > 0 && <AnimatedValue value={contextPercent} color={contextPercent >= 80 ? RED : MUTED} highlight={accent()} format={(n) => `${Math.round(n)}% context`} />}
          </box>
        </box>
      )}
      </box>
    </box>
  )
}
