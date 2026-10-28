// The Claude Code turn engine: pico's controller hands it a turn exactly
// as it would hand pico's own runTurn one, and it plays the turn through a
// long-lived headless `claude` process instead of calling a model API.
//
// pico's session log stays the source of truth. Claude Code keeps its own
// context, which this engine treats as a cache of pico's history: when
// the history the controller passes in is what Claude Code last saw, only
// the new messages are sent; when it is not (a rewind, a steer, a clear, a
// compaction, or a conversation begun with another model), a fresh Claude
// Code session starts with the earlier conversation as a transcript. Which
// Claude session holds which history is returned as `engineState`, which
// the controller saves with the session so a restart resumes it.

import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { hydrateImages } from '../agent.js'
import { spawnClaude } from './cli.js'
import { createBridge } from './bridge.js'
import { claudeCommand, cliModel, CLAUDE_CODE_PROVIDER } from './models.js'
import { addUsage, COVERED_TOOLS, emptyUsage, fingerprint, picoTool, seedText, splitTurn, toolEntry, transcriptText, toolResultText, usageOf, userBlocks } from './translate.js'

const IDLE_MS = 10 * 60 * 1000
// Claude Code's tools that run a subagent
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])
// how long an interrupted turn may take to wind down before the process
// is stopped instead
const INTERRUPT_GRACE_MS = 10000

const HOST_NOTE = `You are running inside pico, an agent runtime, possibly within kagent, a desktop workspace where several agent sessions work side by side. Besides your own tools, the host's tools are available under mcp__pico__: ask_user asks the user questions (use it instead of AskUserQuestion), peer_list and peer_send message other agent sessions, schedule_wakeup schedules a note to your future self, and the host may add more, such as terminals and a browser. Messages that begin with [system notification] or [peer input ...] come from the host or from other agents, not from the user.`

function systemPrompt(contextFiles = [], memoryIndexText = '') {
  // Claude Code reads CLAUDE.md files itself; any other instructions pico
  // would give its own models (AGENTS.md) are passed along
  const files = contextFiles.filter((file) => basename(file.path) !== 'CLAUDE.md' && file.content?.trim())
  const parts = [HOST_NOTE]
  // pico's memories stand in for Claude Code's own, which is switched off;
  // they are saved and loaded with mcp__pico__remember and recall
  if (memoryIndexText) parts.push(memoryIndexText.replace(/\bthe (remember|recall) tool\b/g, 'the mcp__pico__$1 tool'))
  if (files.length) parts.push(`Project instructions:\n\n${files.map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`).join('\n\n')}`)
  return parts.join('\n\n')
}

// the trailing user messages of `history` that Claude Code has not seen,
// given the fingerprint of what it has: null when the history diverged
function unseen(history, synced) {
  if (!synced) return null
  for (let at = history.length; at >= 0; at--) {
    if (at < history.length && history[at].role !== 'user') break
    if (fingerprint(history.slice(0, at)) === synced) return history.slice(at)
  }
  return null
}

export function createClaudeCodeEngine({ command = claudeCommand(), idleMs = IDLE_MS, spawn = spawnClaude, bridge = createBridge } = {}) {
  // per pico session: its process, bridge, and which Claude session holds
  // which history
  const sessions = new Map()

  function stop(entry) {
    clearTimeout(entry.idle)
    entry.proc?.close()
    entry.proc = null
    entry.bridge?.close().catch(() => {})
    entry.bridge = null
  }

  async function start(entry, { cwd, env, model, effort, resume, fork, contextFiles, memoryIndexText }) {
    entry.bridge = await bridge()
    entry.model = model
    entry.effort = effort
    // a process that was replaced still exits, and may still speak, after
    // the next one starts; only the current process reaches the turn
    const proc = spawn({
      command,
      cwd,
      env,
      model,
      effort,
      resume,
      fork,
      mcpConfig: entry.bridge.mcpConfig(),
      appendSystemPrompt: systemPrompt(contextFiles, memoryIndexText),
      onMessage: (message) => { if (entry.proc === proc) entry.onMessage?.(message) },
      onExit: (exit) => {
        if (entry.proc !== proc) return
        entry.proc = null
        entry.lastExit = exit
        entry.onExit?.(exit)
      },
    })
    entry.proc = proc
  }

  async function run({ history, tools, recorder, modelName, effort, signal, onStream = () => {}, beforeRequest, host = {} }) {
    const key = host.sessionId ?? 'ephemeral'
    const entry = sessions.get(key) ?? { claudeSessionId: null, owner: key, synced: null }
    sessions.set(key, entry)
    clearTimeout(entry.idle)
    const model = cliModel(modelName)
    const level = effort && effort !== 'auto' ? effort : null

    // what Claude Code already holds: this process's session, or the one
    // the controller saved, as long as the history has not moved under it
    const known = entry.claudeSessionId ? entry : host.engineState?.claudeSessionId ? host.engineState : null
    const fresh = known ? unseen(history, known.synced) : null
    if (entry.proc && (!fresh || entry.model !== model || entry.effort !== level)) stop(entry)
    let seed = null
    let input = fresh
    if (!entry.proc) {
      if (!fresh) {
        const turn = splitTurn(history)
        input = turn.input
        if (turn.prior.length) seed = seedText(turn.prior)
      }
    }

    const content = []
    if (seed) content.push({ type: 'text', text: seed })
    for (const message of await hydrateImages(input)) content.push(...userBlocks(message))
    if (!content.length) content.push({ type: 'text', text: '[system notification] continue.' })

    if (!entry.proc) {
      entry.lastExit = null
      try {
        await start(entry, { cwd: host.cwd, env: host.env, model, effort: level, resume: fresh ? known.claudeSessionId : null, fork: !!fresh && known.owner !== key, contextFiles: host.contextFiles, memoryIndexText: host.memoryIndexText })
      } catch (error) {
        stop(entry)
        return { messages: [], usage: null, lastPromptTokens: 0, interrupted: true, stalled: false, error: String(error.message || error) }
      }
      if (!fresh) entry.claudeSessionId = null
      entry.owner = key
    }

    const collected = []
    const uses = new Map()
    const unclaimed = []
    const responses = new Map()
    let assistant = null
    let usage = emptyUsage()
    let lastPrompt = 0
    let interrupted = false
    let error = null
    let graceTimer = null

    const flushAssistant = () => {
      if (!assistant) return
      if (assistant.text || assistant.calls.length) collected.push({ role: 'assistant', content: assistant.text, ...(assistant.calls.length ? { tool_calls: assistant.calls } : {}) })
      assistant = null
    }

    // a response's usage arrives in parts: input at its start, output
    // growing until its end
    const raws = new Map()
    let streaming = null
    const countUsage = (id, raw) => {
      if (!id || !raw) return
      raws.set(id, { ...raws.get(id), ...raw })
      responses.set(id, usageOf(raws.get(id)))
      usage = [...responses.values()].reduce(addUsage, emptyUsage())
      lastPrompt = responses.get(id).promptTokens
      onStream({ type: 'usage', usage })
    }

    // Claude Code's messages are handled one at a time, in order
    let chain = Promise.resolve()

    // Claude's subagents, by the id of the Task call that started each,
    // shown in pico's activity list as they work. A subagent's own traffic
    // carries that id as its parent; it may start subagents of its own
    const subagents = new Map()
    const startSubagent = (block) => {
      if (!host.subagents || !SUBAGENT_TOOLS.has(block.name)) return
      // a subagent runs on the session's model unless its call names another
      const handle = host.subagents.start({ description: block.input?.description, prompt: block.input?.prompt ?? '', model: `${CLAUDE_CODE_PROVIDER}/${block.input?.model ?? model}` })
      subagents.set(block.id, { handle })
    }
    // `extra` is the structured result, whose report is free of the frame
    // Claude Code wraps it in for the model
    const finishSubagent = (block, extra) => {
      const sub = subagents.get(block.tool_use_id)
      if (!sub) return
      subagents.delete(block.tool_use_id)
      const text = Array.isArray(extra?.content) ? toolResultText(extra.content) : toolResultText(block.content)
      sub.handle.finish(block.is_error ? { error: text || 'failed', interrupted } : { result: text })
    }
    const onSubagent = (message) => {
      const sub = subagents.get(message.parent_tool_use_id)
      if (!sub) return
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && block.text) sub.handle.event({ type: 'content', content: block.text })
          if (block.type !== 'tool_use') continue
          const { name, args } = picoTool(block.name, block.input, host.cwd)
          sub.handle.event({ type: 'tool_executing', call: { id: block.id, type: 'function', function: { name, arguments: JSON.stringify(args) } }, at: Date.now() })
          startSubagent(block)
        }
      } else if (message.type === 'user') {
        const blocks = (Array.isArray(message.message?.content) ? message.message.content : []).filter((block) => block.type === 'tool_result')
        for (const block of blocks) {
          const text = toolResultText(block.content)
          sub.handle.event(block.is_error ? { type: 'tool_error', call: { id: block.tool_use_id }, error: text } : { type: 'tool_complete', call: { id: block.tool_use_id }, result: text })
          finishSubagent(block, blocks.length === 1 ? message.tool_use_result : null)
        }
      }
    }

    // offered: pico's tools that Claude Code has no version of its own. A
    // call through the bridge lands on the tool_use Claude announced for
    // it (same name, same arguments, oldest first), once every message
    // before it has been handled, since it reaches pico by another channel
    entry.bridge.setTurn(tools.filter((tool) => !COVERED_TOOLS.has(tool.name)), async (name, args) => {
      await chain
      const at = unclaimed.findIndex((use) => use.name === name && JSON.stringify(use.args) === JSON.stringify(args ?? {}))
      const use = at >= 0 ? unclaimed.splice(at, 1)[0] : null
      recorder.currentCall = use ? { id: use.id } : null
    })

    const onAssistant = (message) => {
      const id = message.message?.id
      if (assistant && assistant.id !== id) flushAssistant()
      assistant ??= { id, text: '', calls: [] }
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') assistant.text += block.text
        if (block.type !== 'tool_use') continue
        const { name, args, bridged } = picoTool(block.name, block.input, host.cwd)
        const call = { id: block.id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
        assistant.calls.push(call)
        uses.set(block.id, { id: block.id, name: block.name, input: block.input, call, bridged })
        if (bridged) unclaimed.push({ id: block.id, name, args: block.input ?? {} })
        onStream({ type: 'tool_calls_ready', calls: [call] })
        onStream({ type: 'tool_executing', call })
        startSubagent(block)
      }
      if (!raws.has(id)) countUsage(id, message.message?.usage)
    }

    const onResults = async (message) => {
      const blocks = (Array.isArray(message.message?.content) ? message.message.content : []).filter((block) => block.type === 'tool_result')
      if (!blocks.length) return
      flushAssistant()
      for (const block of blocks) {
        const use = uses.get(block.tool_use_id)
        if (!use) continue
        uses.delete(block.tool_use_id)
        const waiting = unclaimed.findIndex((candidate) => candidate.id === use.id)
        if (waiting >= 0) unclaimed.splice(waiting, 1)
        const text = toolResultText(block.content)
        finishSubagent(block, blocks.length === 1 ? message.tool_use_result : null)
        collected.push({ role: 'tool', tool_call_id: use.id, content: text })
        // a bridged call the bridge never ran (Claude refused it first)
        // has no entry yet, so it gets one like any other call
        if (!use.bridged || !recorder.entries.some((candidate) => candidate.callId === use.id)) {
          // the structured result describes the message's only call
          const extra = blocks.length === 1 ? message.tool_use_result : null
          const path = extra?.filePath
          const after = path && existsSync(path) ? readFileSync(path, 'utf8') : null
          recorder.entries.push(toolEntry(use, block, extra, { cwd: host.cwd, after, interrupted }))
        }
        onStream({ type: block.is_error ? 'tool_error' : 'tool_complete', call: use.call, ...(block.is_error ? { error: text } : { result: text }) })
      }
      // between tool rounds is where pico delivers notes that arrived
      // mid-turn; Claude Code folds a message sent now into the same turn,
      // but cancels any call still running, a subagent's included, as if
      // the user had cut in, so notes wait until every call has finished
      if (interrupted || !beforeRequest || uses.size) return
      const notes = await beforeRequest()
      if (!notes?.length) return
      collected.push(...notes)
      entry.proc?.send(notes.flatMap(userBlocks))
    }

    let outcomeCleanup = () => {}
    const outcome = new Promise((resolve) => {
      entry.onMessage = (message) => {
        chain = chain.then(async () => {
          if (message.parent_tool_use_id) return onSubagent(message)
          if (message.type === 'system' && message.subtype === 'init') entry.claudeSessionId = message.session_id
          else if (message.type === 'stream_event') {
            const event = message.event
            if (event.type === 'message_start') {
              streaming = event.message?.id ?? null
              countUsage(streaming, event.message?.usage)
            } else if (event.type === 'message_delta') countUsage(streaming, event.usage)
            else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) onStream({ type: 'content', content: event.delta.text })
            else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) onStream({ type: 'thinking', content: event.delta.thinking })
          } else if (message.type === 'assistant') onAssistant(message)
          else if (message.type === 'user') await onResults(message)
          else if (message.type === 'result') {
            entry.claudeSessionId = message.session_id ?? entry.claudeSessionId
            if (message.is_error && !interrupted) error = message.result || message.errors?.join('; ') || message.subtype
            resolve()
          }
        }).catch((failure) => { error = String(failure.message || failure); resolve() })
      }
      entry.onExit = (exit) => {
        if (!interrupted) error = exit.error?.message || exit.stderr || 'Claude Code stopped'
        resolve()
      }
      const onAbort = () => {
        interrupted = true
        entry.proc?.interrupt().catch(() => {})
        graceTimer = setTimeout(() => { stop(entry); resolve() }, INTERRUPT_GRACE_MS)
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      outcomeCleanup = () => signal?.removeEventListener('abort', onAbort)
    })

    // a process that failed to start takes its input nowhere, and says
    // why as it exits, which may already have happened
    const sent = !!entry.proc?.send(content)
    await (sent ? outcome : Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 2000))]))
    if (!sent) error ??= entry.lastExit?.error?.message || entry.lastExit?.stderr || 'Claude Code is not running'
    clearTimeout(graceTimer)
    outcomeCleanup()
    entry.onMessage = null
    entry.onExit = null
    flushAssistant()
    for (const sub of subagents.values()) sub.handle.finish({ interrupted: true })
    // a call cut off by an interrupt still needs a result, or the history
    // is invalid for whichever model reads it next
    for (const use of uses.values()) collected.push({ role: 'tool', tool_call_id: use.id, content: '[interrupted before it finished]' })

    if (entry.proc) {
      entry.synced = fingerprint([...history, ...collected])
      entry.idle = setTimeout(() => stop(entry), idleMs)
      entry.idle.unref?.()
    } else {
      // the process died: what Claude Code saved may not match, so the
      // next turn starts over from pico's history
      entry.claudeSessionId = null
      entry.synced = null
    }
    return {
      messages: collected,
      usage: responses.size ? usage : null,
      lastPromptTokens: lastPrompt,
      interrupted: interrupted || !!error,
      stalled: false,
      ...(error ? { error } : {}),
      engineState: { claudeSessionId: entry.claudeSessionId, owner: entry.owner, synced: entry.synced },
    }
  }

  // pico's compaction, done by the same model: one bare Claude Code run
  // that reads the conversation and writes the summary
  async function compact({ history, modelName, prompt, signal, onStream = () => {} }) {
    let text = ''
    let failure = null
    let proc = null
    await new Promise((resolve) => {
      proc = spawn({
        command,
        cwd: process.cwd(),
        model: cliModel(modelName),
        oneShot: true,
        onMessage: (message) => {
          if (message.type === 'stream_event' && message.event?.delta?.type === 'text_delta') {
            text += message.event.delta.text
            onStream({ type: 'content', content: message.event.delta.text })
          } else if (message.type === 'result') {
            if (message.is_error) failure = message.result || message.subtype
            else text = message.result ?? text
            proc.close()
            resolve()
          }
        },
        onExit: (exit) => { failure ??= exit.error?.message ?? null; resolve() },
      })
      signal?.addEventListener('abort', () => { proc.close(); resolve() }, { once: true })
      proc.send(`<transcript>\n${transcriptText(history)}\n</transcript>\n\n${prompt}`)
    })
    if (signal?.aborted) throw new Error('compaction cancelled')
    if (failure) throw new Error(failure)
    return text.trim()
  }

  return {
    name: CLAUDE_CODE_PROVIDER,
    // Claude Code compacts its own context as it fills; pico compacting
    // too would only restart the Claude session from a summary
    autoCompact: false,
    run,
    compact,
    // the pico session is done with: its process and bridge go
    release(sessionId) {
      const entry = sessions.get(sessionId)
      if (!entry) return
      stop(entry)
      sessions.delete(sessionId)
    },
    releaseAll() {
      for (const entry of sessions.values()) stop(entry)
      sessions.clear()
    },
  }
}
