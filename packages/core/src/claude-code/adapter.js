// Claude Code as an ACP agent. Claude Code speaks its own stream-json
// (the protocol the Claude Agent SDK drives it with); this adapter speaks
// ACP to its client and stream-json to one headless `claude` process per
// session, on the user's own Claude subscription.
//
// - A session's id is Claude Code's own session id, so a session resumes
//   with --resume after any restart, and forks with --fork-session.
// - The model and effort are session options; changing one restarts the
//   process on the same session.
// - Claude's tool calls become ACP tool calls, labelled with the pico tool
//   each amounts to; an edit's update carries the whole file before and
//   after, so a client can show the change and undo it.
// - A subagent's traffic carries the id of the call that started it.
// - A prompt sent while one runs is folded into the running turn, as
//   Claude Code takes a message sent mid-turn; both answer when it ends.
// - `_meta.pico.ephemeral` opens a bare session: no tools, nothing saved.

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { RpcError } from '../acp/rpc.js'
import { spawnClaude } from './cli.js'
import { claudeCommand, FAMILIES } from './models.js'
import { acpKind, addUsage, callTitle, claudeContent, emptyUsage, mcpConfig, picoTool, promptSize, SUBAGENT_TOOLS, toolPath, toolResultText, usageOf } from './translate.js'

const CONTEXT = 1000000
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function configOptions(session) {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: FAMILIES.map(({ alias, label }) => ({ value: alias, name: label })) },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: session.effort ?? 'auto', options: [{ value: 'auto', name: 'Auto' }, ...EFFORTS.map((value) => ({ value, name: value }))] },
  ]
}

const readText = (path) => {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null } catch { return null }
}

export function createClaudeCodeAgent(client, { exit = () => {} } = {}, { command = claudeCommand(), cwd: defaultCwd = process.cwd(), env = {}, spawn = spawnClaude } = {}) {
  const sessions = new Map()

  function session(id) {
    const found = sessions.get(id)
    if (!found) throw new RpcError(`no session ${id}`, -32602)
    return found
  }

  function open(params, id, from = {}) {
    const meta = params._meta?.pico ?? {}
    const entry = {
      id,
      cwd: params.cwd ?? defaultCwd,
      servers: params.mcpServers ?? [],
      systemPrompt: meta.systemPrompt ?? '',
      ephemeral: !!meta.ephemeral,
      model: 'opus',
      effort: null,
      // how the process starts: as a new session, resuming this one, or forking another into this one
      resume: from.resume ?? null,
      fork: !!from.fork,
      proc: null,
      turn: null,
    }
    sessions.set(id, entry)
    return entry
  }

  function stop(entry) {
    entry.proc?.close()
    entry.proc = null
  }

  const send = (entry, update) => client.notify('session/update', { sessionId: entry.id, update })

  // the process for a session, started as its options say
  function processFor(entry) {
    if (entry.proc?.alive) return entry.proc
    const proc = spawn({
      command,
      cwd: entry.cwd,
      env,
      model: entry.model,
      effort: entry.effort,
      resume: entry.resume,
      fork: entry.fork,
      sessionId: entry.resume && !entry.fork ? null : entry.id,
      oneShot: entry.ephemeral,
      ...(entry.ephemeral ? {} : { mcpConfig: mcpConfig(entry.servers) }),
      ...(entry.systemPrompt ? { appendSystemPrompt: entry.systemPrompt } : {}),
      onMessage: (message) => { if (entry.proc === proc) onMessage(entry, message) },
      onExit: (ended) => {
        if (entry.proc !== proc) return
        entry.proc = null
        const turn = entry.turn
        if (!turn) return
        entry.turn = null
        const error = new Error(ended.error?.message || ended.stderr || 'Claude Code stopped')
        if (turn.cancelled) for (const waiter of turn.waiters) waiter.resolve({ stopReason: 'cancelled', usage: turn.usage })
        else {
          for (const waiter of turn.waiters) waiter.reject(error)
          // what Claude Code kept may not match what the client holds, so the connection ends with it
          exit(error)
        }
      },
    })
    entry.proc = proc
    // from here on the session exists on Claude Code's side, under its own id
    entry.resume = entry.id
    entry.fork = false
    return proc
  }

  // ---- one turn's messages, as ACP updates ----

  function onMessage(entry, message) {
    const turn = entry.turn
    if (!turn) return
    const parent = message.parent_tool_use_id ?? null
    const meta = (extra = {}) => ({ _meta: { pico: { ...(parent ? { parentToolCallId: parent } : {}), ...extra } } })
    if (message.type === 'stream_event' && !parent) {
      const event = message.event
      if (event.type === 'message_start') { turn.streaming = event.message?.id ?? null; countUsage(entry, turn.streaming, event.message?.usage) }
      else if (event.type === 'message_delta') countUsage(entry, turn.streaming, event.usage)
      else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) send(entry, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.delta.text } })
      else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) send(entry, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.delta.thinking } })
    } else if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        // the main agent's text came as it streamed; a subagent's comes whole
        if (block.type === 'text' && block.text && parent) send(entry, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text }, ...meta() })
        if (block.type !== 'tool_use') continue
        const tool = picoTool(block.name, block.input, entry.cwd, entry.servers.map((s) => s.name))
        const path = toolPath(block.input)
        turn.uses.set(block.id, { name: block.name, input: block.input, before: path && acpKind(block.name) === 'edit' ? readText(path) : null })
        send(entry, {
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: callTitle(block.name, block.input, entry.cwd),
          kind: acpKind(block.name),
          status: 'in_progress',
          rawInput: block.input,
          ...(path ? { locations: [{ path }] } : {}),
          ...meta({
            tool: { name: tool.name, args: tool.args },
            ...(tool.bridged ? { bridged: true } : {}),
            ...(SUBAGENT_TOOLS.has(block.name) ? { subagent: { description: block.input?.description, prompt: block.input?.prompt ?? '', ...(block.input?.model ? { model: block.input.model } : {}) } } : {}),
          }),
        })
      }
      if (!parent && message.message?.id && !turn.raws.has(message.message.id)) countUsage(entry, message.message.id, message.message.usage)
    } else if (message.type === 'user') {
      const blocks = (Array.isArray(message.message?.content) ? message.message.content : []).filter((block) => block.type === 'tool_result')
      for (const block of blocks) {
        const use = turn.uses.get(block.tool_use_id)
        turn.uses.delete(block.tool_use_id)
        // the structured result describes the message's only call
        const extra = blocks.length === 1 ? message.tool_use_result : null
        const text = toolResultText(Array.isArray(extra?.content) && use && SUBAGENT_TOOLS.has(use.name) ? extra.content : block.content)
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId: block.tool_use_id,
          status: block.is_error ? 'failed' : 'completed',
          content: [{ type: 'content', content: { type: 'text', text: block.is_error ? text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, '') : text } }],
          ...(extra && typeof extra === 'object' ? { rawOutput: extra } : {}),
        }
        // an edit's whole file, before and after, for the client to show and undo
        const file = !block.is_error && extra && typeof extra.filePath === 'string' ? extra.filePath : null
        if (file && use && acpKind(use.name) === 'edit') {
          const before = typeof extra.originalFile === 'string' ? extra.originalFile : (extra.type === 'create' ? null : use.before)
          const after = readText(file) ?? (typeof extra.content === 'string' ? extra.content : null)
          if (after !== null) {
            update.content.push({ type: 'diff', path: file, oldText: before, newText: after })
            Object.assign(update, meta({ wholeFile: true }))
          }
        }
        if (parent && !update._meta) Object.assign(update, meta())
        send(entry, update)
      }
    } else if (message.type === 'result') {
      entry.turn = null
      const reply = { stopReason: turn.cancelled ? 'cancelled' : 'end_turn', usage: turn.usage }
      const failure = message.is_error && !turn.cancelled ? new RpcError(message.result || message.errors?.join('; ') || message.subtype || 'Claude Code failed') : null
      for (const waiter of turn.waiters) failure ? waiter.reject(failure) : waiter.resolve(reply)
    }
  }

  // a response's usage arrives in parts: input at its start, output
  // growing until its end
  function countUsage(entry, id, raw) {
    const turn = entry.turn
    if (!turn || !id || !raw) return
    turn.raws.set(id, { ...turn.raws.get(id), ...raw })
    const each = [...turn.raws.values()].map(usageOf)
    turn.usage = each.reduce(addUsage, emptyUsage())
    const last = usageOf(turn.raws.get(id))
    send(entry, { sessionUpdate: 'usage_update', used: promptSize(last), size: CONTEXT, _meta: { pico: { usage: picoUsage(turn.usage) } } })
  }
  const picoUsage = (u) => ({ promptTokens: promptSize(u), completionTokens: u.outputTokens, totalTokens: u.totalTokens, cachedTokens: u.cachedReadTokens, thoughtTokens: 0 })

  // ---- ACP methods ----

  const methods = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, fork: {}, close: {} },
      },
      agentInfo: { name: 'pico-claude-code', title: 'Claude Code', version: '1' },
      authMethods: [],
    }),
    'session/new': (params) => {
      const entry = open(params, randomUUID())
      return { sessionId: entry.id, configOptions: configOptions(entry) }
    },
    'session/resume': (params) => {
      const entry = sessions.get(params.sessionId) ?? open(params, params.sessionId, { resume: params.sessionId })
      return { configOptions: configOptions(entry) }
    },
    'session/fork': (params) => {
      const entry = open(params, randomUUID(), { resume: params.sessionId, fork: true })
      return { sessionId: entry.id, configOptions: configOptions(entry) }
    },
    'session/set_config_option': ({ sessionId, configId, value }) => {
      const entry = session(sessionId)
      const key = configId === 'model' ? 'model' : configId === 'effort' ? 'effort' : null
      if (!key) throw new RpcError(`no option ${configId}`, -32602)
      const next = key === 'effort' && value === 'auto' ? null : String(value)
      if (entry[key] !== next) {
        entry[key] = next
        // a running turn keeps its process; the next one starts on the new option
        if (!entry.turn) stop(entry)
      }
      return { configOptions: configOptions(entry) }
    },
    'session/prompt': ({ sessionId, prompt }) => {
      const entry = session(sessionId)
      const content = claudeContent(prompt)
      return new Promise((resolve, reject) => {
        // a prompt sent while a turn runs joins it, and answers with it
        if (entry.turn) {
          entry.turn.waiters.push({ resolve, reject })
          entry.proc?.send(content)
          return
        }
        entry.turn = { waiters: [{ resolve, reject }], uses: new Map(), raws: new Map(), usage: emptyUsage(), streaming: null, cancelled: false }
        const proc = processFor(entry)
        if (!proc.send(content)) {
          entry.turn = null
          reject(new RpcError(proc.stderr || 'Claude Code is not running'))
        }
      })
    },
    'session/close': ({ sessionId }) => {
      const entry = sessions.get(sessionId)
      if (entry) { stop(entry); sessions.delete(sessionId) }
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
      entry.proc?.interrupt().catch(() => {})
    },
    close() {
      for (const entry of sessions.values()) stop(entry)
      sessions.clear()
    },
  }
}
