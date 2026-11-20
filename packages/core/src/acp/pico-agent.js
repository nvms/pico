// pico as an ACP agent, for any ACP app: each ACP session is a whole pico
// session (its log, tools, compaction, memories, MCP servers), on any model
// this machine can run, whether pico calls the model itself (API keys,
// ChatGPT, SuperGrok) or drives an agent over ACP (Claude Code,
// Antigravity). The app picks the model and thinking effort as session
// options, and signs in to a subscription with `authenticate`.
//
// What ACP has no words for, pico says under its own names:
// - `_pico/sign_in` (notification): a sign-in begun by `authenticate`
//   shows its page, { methodId, url, code?, input }; `input` says what the
//   person brings back from it by hand ('code', 'redirect' or null)
// - `_pico/sign_in/finish` { methodId, input }: hands that in
// - `_pico/sign_in/cancel` { methodId }
// - `usage_update` carries the turn's usage so far under `_meta.pico.usage`

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { RpcError } from './rpc.js'
import { acpUsage, picoContent } from './translate.js'
import { createLocalSession } from '../local-session.js'
import { loadModelRuntime } from '../model-runtime.js'
import { formatServerSpec } from '../mcp.js'
import { listSessions } from '../session.js'
import { findProjectRoot, sessionsDir } from '../paths.js'
import { defaultTitle } from '../tools/recorder.js'
import { SIGN_INS, signInFor } from '../sign-in/index.js'

const EFFORTS = ['low', 'medium', 'high', 'max']

const PROVIDER_LABELS = { 'claude-code': 'Claude Code', antigravity: 'Antigravity', codex: 'ChatGPT', grok: 'SuperGrok', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', openrouter: 'OpenRouter' }

// the kind ACP apps show a pico tool call as
export function kindOf(name) {
  if (name === 'bash') return 'execute'
  if (['read', 'view'].includes(name)) return 'read'
  if (['edit', 'write'].includes(name)) return 'edit'
  if (['glob', 'grep'].includes(name)) return 'search'
  if (/^(web_|browser_)/.test(name)) return 'fetch'
  return 'other'
}

// the MCP servers an ACP app gives a session, as pico names them
export function sessionServers(servers = []) {
  const pairs = (list = []) => Object.fromEntries(list.map(({ name, value }) => [name, value]))
  return Object.fromEntries(servers.map((s) => [s.name, formatServerSpec(s.type === 'http' || s.type === 'sse'
    ? { type: 'http', url: s.url, headers: pairs(s.headers) }
    : { type: 'stdio', command: s.command, args: s.args ?? [], env: pairs(s.env) })]))
}

// a finished pico tool call as an ACP update
export function callUpdate(entry, { id, cwd }) {
  const failed = entry?.status === 'error'
  const text = String(entry?.fullOutput ?? entry?.resultText ?? entry?.error ?? '')
  const content = [{ type: 'content', content: { type: 'text', text } }]
  const args = entry?.args ?? {}
  const path = typeof args.path === 'string' ? (isAbsolute(args.path) ? args.path : join(cwd, args.path)) : null
  if (!failed && path && entry.name === 'edit' && typeof args.newText === 'string') content.push({ type: 'diff', path, oldText: args.oldText ?? '', newText: args.newText })
  if (!failed && path && entry.name === 'write' && typeof args.content === 'string') content.push({ type: 'diff', path, oldText: entry.created ? null : '', newText: args.content })
  return { sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : entry?.status === 'interrupted' ? 'failed' : 'completed', content }
}

export function createPicoAgent(client, { exit = () => {} } = {}, { openSession = createLocalSession, loadRuntime = loadModelRuntime, version = '1' } = {}) {
  const sessions = new Map()
  const signIns = new Map()
  let runtime = null
  const models = () => (runtime ??= loadRuntime())

  function session(id) {
    const found = sessions.get(id)
    if (!found) throw new RpcError(`no session ${id}`, -32602)
    return found
  }

  const send = (entry, update) => client.notify('session/update', { sessionId: entry.id, update })

  function configOptions(entry) {
    const ctl = entry.ctl
    const available = ctl.boot.models.filter((m) => m.available !== false)
    const groups = new Map()
    for (const m of available) {
      if (!groups.has(m.provider)) groups.set(m.provider, { group: m.provider, name: PROVIDER_LABELS[m.provider] ?? m.provider, options: [] })
      groups.get(m.provider).options.push({ value: m.name, name: m.label ?? m.name })
    }
    const options = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: ctl.state.model.name, options: [...groups.values()] }]
    if (ctl.effortApplies()) options.push({ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: ctl.state.effort ?? 'auto', options: [{ value: 'auto', name: 'Auto' }, ...EFFORTS.map((value) => ({ value, name: value }))] })
    return options
  }

  // a turn's events, as ACP updates as they happen
  function relay(entry, event, recorder) {
    if (event.type === 'content') send(entry, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.content } })
    else if (event.type === 'thinking') send(entry, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.content } })
    else if (event.type === 'tool_executing') {
      let args = {}
      try { args = JSON.parse(event.call.function.arguments) } catch {}
      const name = event.call.function.name
      const path = typeof args.path === 'string' ? (isAbsolute(args.path) ? args.path : join(entry.cwd, args.path)) : null
      send(entry, { sessionUpdate: 'tool_call', toolCallId: event.call.id, title: args.description || defaultTitle(name, args), kind: kindOf(name), status: 'in_progress', rawInput: args, ...(path ? { locations: [{ path }] } : {}) })
    } else if (event.type === 'tool_complete' || event.type === 'tool_error') {
      const row = recorder.entries.findLast((candidate) => candidate.callId === event.call.id)
      send(entry, callUpdate(row ?? { name: event.call.function?.name, status: event.type === 'tool_error' ? 'error' : 'done', fullOutput: event.error ?? event.result }, { id: event.call.id, cwd: entry.cwd }))
    } else if (event.type === 'usage') {
      send(entry, { sessionUpdate: 'usage_update', used: entry.ctl.state.derived.lastPromptTokens || 0, size: entry.ctl.state.model.context || 0, _meta: { pico: { usage: event.usage } } })
    }
  }

  // pico's questions, asked of the person through the app: a choice as a
  // permission with the choices as its options. ACP has no way to ask for
  // a written answer, so such a question is answered as unanswerable
  async function ask(entry, question) {
    const answers = []
    for (const [n, q] of question.questions.entries()) {
      if (q.type === 'text' || !q.options?.length) { answers.push('(no answer: this app cannot take a written answer)'); continue }
      const reply = await client.request('session/request_permission', {
        sessionId: entry.id,
        toolCall: { toolCallId: `question-${Date.now()}-${n}`, title: q.question, kind: 'other', status: 'pending', rawInput: { question: q.question } },
        options: q.options.map((o) => ({ optionId: o.label, name: o.label, kind: 'allow_once' })),
      }).catch(() => null)
      if (reply?.outcome?.outcome !== 'selected') { entry.ctl.cancelQuestion(); return }
      answers.push(reply.outcome.optionId)
    }
    entry.ctl.answerQuestion(answers)
  }

  async function open(params) {
    const cwd = params.cwd ?? process.cwd()
    const holder = { id: null, cwd, turn: null, ctl: null }
    const opened = await openSession({ cwd, runtime: await models(), mcpServers: sessionServers(params.mcpServers), extra: { onTurnEvent: (event, recorder) => relay(holder, event, recorder) } })
    holder.ctl = opened.controller
    holder.dispose = opened.dispose
    holder.ctl.on('question', (question) => { ask(holder, question).catch(() => holder.ctl.cancelQuestion()) })
    holder.ctl.on('flash', (text) => { if (holder.turn && /^error:/.test(text)) holder.turn.error = text.replace(/^error:\s*/, '') })
    holder.ctl.on('change', () => {
      const turn = holder.turn
      if (!turn) return
      if (holder.ctl.state.busy) turn.started = true
      else if (turn.started && !holder.ctl.isWorking()) finishTurn(holder)
    })
    return holder
  }

  function finishTurn(entry) {
    const turn = entry.turn
    entry.turn = null
    const now = entry.ctl.state.derived.usage
    const usage = Object.fromEntries(Object.keys(now).map((key) => [key, (now[key] || 0) - (turn.before[key] || 0)]))
    const interrupted = turn.cancelled || entry.ctl.state.events.at(-1)?.type === 'interrupt'
    if (turn.error && !turn.cancelled) turn.reject(new RpcError(turn.error))
    else turn.resolve({ stopReason: interrupted ? 'cancelled' : 'end_turn', usage: acpUsage(usage) })
  }

  const fileOf = (cwd, sessionId) => join(sessionsDir(findProjectRoot(cwd)), `${basename(String(sessionId))}.jsonl`)

  async function reopen(params, { replay }) {
    const entry = await open(params)
    const file = fileOf(entry.cwd, params.sessionId)
    await entry.ctl.resume({ file, header: { root: entry.ctl.boot.root, cwd: entry.cwd } })
    entry.id = entry.ctl.state.session?.id
    if (entry.id !== params.sessionId) { entry.dispose(); throw new RpcError(`no session ${params.sessionId} here`, -32602) }
    sessions.set(entry.id, entry)
    if (replay) {
      for (const item of entry.ctl.state.derived.transcript) {
        if (item.kind === 'user') send(entry, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: String(item.text ?? '') } })
        else if (item.kind === 'assistant') send(entry, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(item.text ?? '') } })
        else if (item.kind === 'tool' && item.callId) {
          send(entry, { sessionUpdate: 'tool_call', toolCallId: item.callId, title: item.title ?? item.name, kind: kindOf(item.name), status: 'in_progress', rawInput: item.args ?? {} })
          send(entry, callUpdate({ ...item, status: item.status === 'error' ? 'error' : 'done' }, { id: item.callId, cwd: entry.cwd }))
        }
      }
    }
    return entry
  }

  const methods = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, list: {} },
        auth: { logout: {} },
      },
      agentInfo: { name: 'pico', title: 'pico', version },
      authMethods: Object.entries(SIGN_INS).map(([id, s]) => ({ id, name: `Sign in to ${s.label}` })),
    }),

    authenticate: async ({ methodId }) => {
      const signIn = signInFor(methodId)
      signIns.get(methodId)?.cancel()
      const flow = await signIn.start()
      signIns.set(methodId, flow)
      try {
        const page = await flow.page
        client.notify('_pico/sign_in', { methodId, url: page.url, ...(page.code ? { code: page.code } : {}), input: flow.input })
        await flow.done
        runtime = null
        return {}
      } finally {
        if (signIns.get(methodId) === flow) signIns.delete(methodId)
      }
    },
    '_pico/sign_in/finish': async ({ methodId, input }) => {
      const flow = signIns.get(methodId)
      if (!flow) throw new RpcError('no sign-in is under way', -32602)
      await flow.finish(input)
      return {}
    },
    '_pico/sign_in/cancel': ({ methodId }) => {
      signIns.get(methodId)?.cancel()
      return {}
    },
    logout: async ({ methodId }) => {
      await signInFor(methodId).signOut()
      runtime = null
      return {}
    },

    'session/new': async (params) => {
      const entry = await open(params)
      entry.ctl.ensureSession()
      entry.id = entry.ctl.state.session.id
      sessions.set(entry.id, entry)
      return { sessionId: entry.id, configOptions: configOptions(entry) }
    },
    'session/load': async (params) => {
      const entry = sessions.get(params.sessionId) ?? await reopen(params, { replay: true })
      return { configOptions: configOptions(entry) }
    },
    'session/resume': async (params) => {
      const entry = sessions.get(params.sessionId) ?? await reopen(params, { replay: false })
      return { configOptions: configOptions(entry) }
    },
    'session/list': async ({ cwd = process.cwd() } = {}) => {
      const listed = await listSessions({ scope: 'project', root: findProjectRoot(cwd) })
      return { sessions: listed.map((s) => ({ sessionId: s.header?.id ?? basename(s.file, '.jsonl'), cwd: s.header?.cwd ?? cwd, title: s.title, updatedAt: new Date(s.at).toISOString() })) }
    },
    'session/set_config_option': ({ sessionId, configId, value }) => {
      const entry = session(sessionId)
      if (configId === 'model') entry.ctl.switchModelByName(String(value))
      else if (configId === 'effort') entry.ctl.setEffortByName(value === 'auto' ? 'default' : String(value))
      else throw new RpcError(`no option ${configId}`, -32602)
      return { configOptions: configOptions(entry) }
    },
    'session/prompt': ({ sessionId, prompt }) => {
      const entry = session(sessionId)
      if (entry.turn) throw new RpcError('a turn is already running in this session', -32602)
      const content = picoContent(prompt)
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
      // an image comes in as data; pico attaches images by file
      const text = parts.map((part) => {
        if (part.type === 'text') return part.text
        const dir = mkdtempSync(join(tmpdir(), 'pico-acp-image-'))
        const file = join(dir, `image.${(part.source.mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`)
        writeFileSync(file, Buffer.from(part.source.data, 'base64'))
        return entry.ctl.attachImage(file) ?? ''
      }).join('\n')
      return new Promise((resolve, reject) => {
        entry.turn = { resolve, reject, started: false, cancelled: false, error: null, before: { ...entry.ctl.state.derived.usage } }
        entry.ctl.send(text)
        // nothing to do: the controller took no turn
        setTimeout(() => { if (entry.turn && !entry.turn.started && !entry.ctl.isWorking()) finishTurn(entry) }, 1000)
      })
    },
    'session/close': async ({ sessionId }) => {
      const entry = sessions.get(sessionId)
      if (!entry) return {}
      sessions.delete(sessionId)
      await entry.ctl.shutdown()
      entry.dispose()
      return {}
    },
  }

  return {
    async handle(method, params) {
      if (!methods[method]) throw new RpcError(`${method} is not handled here`, -32601)
      return methods[method](params ?? {})
    },
    notification(method, params) {
      if (method !== 'session/cancel') return
      const entry = sessions.get(params.sessionId)
      if (!entry?.turn) return
      entry.turn.cancelled = true
      entry.ctl.interrupt()
    },
    // every session ends with all it said written down
    async close() {
      for (const flow of signIns.values()) flow.cancel()
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(open.map(async (entry) => { await entry.ctl.shutdown().catch(() => {}); entry.dispose() }))
    },
  }
}
