// The turn engine for every agent pico reaches over ACP (engines.js):
// Claude Code and Antigravity, through their adapters. pico's controller
// hands it a turn exactly as it would hand pico's own runTurn one, and it
// plays the turn through the agent's ACP session instead of calling a
// model API.
//
// pico's session log stays the source of truth, and the agent's
// conversation is a cache of it (engine-history.js): when the history the
// controller passes in is what the agent last saw, only the new messages
// are sent; when it is not, a fresh session starts with the earlier
// conversation as a transcript. Which agent session holds which history is
// returned as `engineState`, which the controller saves with the session
// so a restart resumes it, and a forked pico session forks it where the
// agent can.

import { existsSync, readFileSync } from 'node:fs'
import { hydrateImages } from '../agent.js'
import { makeDiff } from '../tools/diff.js'
import { makeWriteEdit } from '../reversible-edit.js'
import { createBridge } from '../tool-bridge.js'
import { initialize } from './connect.js'
import { fingerprint, seedText, splitTurn, transcriptText, unseen } from '../engine-history.js'
import { allowOption, callPath, changesFile, chosenOption, diffsOf, modelOption, picoMeta, questionOf, resultText, thoughtOption, thoughtValue, toolOf, usageOf, userBlocks } from './translate.js'

const IDLE_MS = 10 * 60 * 1000
// how long a cancelled turn may take to wind down before the agent is
// stopped instead
const CANCEL_GRACE_MS = 15000
// how long a call through the bridge waits for the agent to announce it
const CLAIM_WAIT_MS = 2000

// pico's tools an agent with its own coding tools does not need; offering
// both would only make the model choose between equivalent tools. A host
// that decides this itself passes its own list (boot.engineOwnTools)
export const COVERED_TOOLS = new Set([
  'read', 'write', 'edit', 'bash', 'glob', 'grep', 'view', 'shell_output', 'shell_kill', 'tool_result',
  'skill',
])

export const HOST_NOTE = `You are running inside pico, an agent runtime, possibly within a desktop workspace where several agent sessions work side by side. Besides your own tools, the host's tools are available from the MCP server named pico: ask_user asks the user questions, peer_list and peer_send message other agent sessions, schedule_wakeup schedules a note to your future self, and the host may add more, such as terminals and a browser. Messages that begin with [system notification] or [peer input ...] come from the host or from other agents, not from the user.`

// ACP's answer that the agent has no sign-in to use
export const isSignInRequired = (error) => error?.code === -32000 || /^No browser is available here/.test(String(error?.message ?? ''))

// pico's tool bridge as ACP names an MCP server
const acpServer = ({ name, command, args, env }) => ({ name, command, args, env: Object.entries(env).map(([key, value]) => ({ name: key, value })) })

const readText = (path) => {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null } catch { return null }
}

// `provider` names the models this engine runs (`<provider>/<model>`),
// `label` the agent as the person knows it, `connect(handlers)` opens a
// connection to it, `systemPrompt(host)` is what pico adds to the agent's
// own instructions, `covered` the pico tools the agent has its own of, and
// `offer(tool)` how a pico tool is described to it
export function createAcpEngine({ provider, label, connect, systemPrompt, covered: ownTools = COVERED_TOOLS, offer = (tool) => tool, idleMs = IDLE_MS, bridge = createBridge }) {
  const signInRequired = `${label} is not signed in on this machine`
  const local = (name) => (String(name).startsWith(`${provider}/`) ? name.slice(provider.length + 1) : name)
  // per pico session: its connection, bridge, agent session, and which
  // history that session holds
  const sessions = new Map()

  function stop(entry) {
    clearTimeout(entry.idle)
    entry.conn?.close()
    entry.conn = null
    entry.bridge?.close().catch(() => {})
    entry.bridge = null
  }

  // a connection with an agent session in it: the saved one resumed, or
  // forked for a forked pico session, where the agent can; else a new one
  async function start(entry, { host, resume, fork }) {
    entry.bridge = await bridge()
    // a connection that was replaced may still speak after the next one
    // opens; only the current one reaches the turn
    const conn = connect({
      cwd: host.cwd,
      env: host.env,
      onNotification: (method, params) => { if (entry.conn === conn) entry.onNotification?.(method, params) },
      onRequest: async (method, params) => {
        if (entry.conn === conn && entry.onRequest) return entry.onRequest(method, params)
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
        throw Object.assign(new Error(`pico does not handle ${method}`), { code: -32601 })
      },
      onExit: (exit) => {
        if (entry.conn !== conn) return
        entry.conn = null
        entry.lastExit = exit
        entry.onExit?.(exit)
      },
    })
    entry.conn = conn
    const hello = await initialize(conn)
    const can = hello?.agentCapabilities?.sessionCapabilities ?? {}
    const params = { cwd: host.cwd, mcpServers: [acpServer(entry.bridge.server())], _meta: { pico: { systemPrompt: systemPrompt(host) } } }
    const refused = (error) => { throw isSignInRequired(error) ? new Error(signInRequired) : error }
    let session = null
    let resumed = false
    if (resume && fork && can.fork) session = await conn.request('session/fork', { sessionId: resume, ...params }).catch((error) => { if (isSignInRequired(error)) refused(error); return null })
    else if (resume && !fork && can.resume) {
      session = await conn.request('session/resume', { sessionId: resume, ...params }).catch((error) => { if (isSignInRequired(error)) refused(error); return null })
      if (session) session.sessionId ??= resume
    }
    if (session) resumed = true
    session ??= await conn.request('session/new', params).catch(refused)
    entry.sessionId = session.sessionId
    entry.configOptions = session.configOptions ?? []
    return { resumed }
  }

  // the model and thinking level asked for, set on the session where they differ
  async function configure(entry, model, effort) {
    const set = async (option, value) => {
      if (!option || value == null || String(option.currentValue) === String(value)) return
      const reply = await entry.conn.request('session/set_config_option', { sessionId: entry.sessionId, configId: option.id, value })
      entry.configOptions = reply?.configOptions ?? entry.configOptions.map((o) => (o.id === option.id ? { ...o, currentValue: value } : o))
    }
    // a resumed session may not report its options; the model is still set by its usual name
    await set(modelOption(entry.configOptions) ?? (entry.configOptions.length ? null : { id: 'model' }), model)
    await set(thoughtOption(entry.configOptions), thoughtValue(entry.configOptions, effort))
  }

  async function run({ history, tools, recorder, modelName, effort, signal, onStream = () => {}, beforeRequest, host = {} }) {
    const key = host.sessionId ?? 'ephemeral'
    const entry = sessions.get(key) ?? { sessionId: null, owner: key, synced: null }
    sessions.set(key, entry)
    clearTimeout(entry.idle)
    const model = local(modelName)

    // what the agent already holds: this connection's session, or the one
    // the controller saved, as long as the history has not moved under it
    const saved = host.engineState ? { ...host.engineState, sessionId: host.engineState.sessionId ?? host.engineState.claudeSessionId } : null
    const known = entry.sessionId ? entry : saved?.sessionId ? saved : null
    const fresh = known ? unseen(history, known.synced) : null
    if (entry.conn && !fresh) stop(entry)
    let input = fresh
    let seed = null
    const failed = (error) => ({ messages: [], usage: null, lastPromptTokens: 0, interrupted: true, stalled: false, error: String(error.message || error) })

    if (!entry.conn) {
      entry.lastExit = null
      try {
        const { resumed } = await start(entry, { host, resume: fresh ? known.sessionId : null, fork: !!fresh && known.owner !== key })
        if (!resumed) {
          const turn = splitTurn(history)
          input = turn.input
          seed = turn.prior.length ? seedText(turn.prior, label) : null
        }
      } catch (error) {
        stop(entry)
        entry.sessionId = null
        return failed(entry.lastExit?.error ?? error)
      }
      entry.owner = key
    }
    try {
      await configure(entry, model, effort)
    } catch (error) {
      return failed(new Error(`${label} could not switch to ${model}: ${error.message}`))
    }

    const content = []
    if (seed) content.push({ type: 'text', text: seed })
    for (const message of await hydrateImages(input)) content.push(...userBlocks(message))
    if (!content.length) content.push({ type: 'text', text: '[system notification] continue.' })

    // the turn as rounds: what the model said, the calls it made then, and
    // their results. A round ends once a result arrives, and the next text
    // or call begins another, so every call's result follows the message
    // that made it
    const rounds = []
    const calls = new Map()
    let usage = null
    let lastPrompt = 0
    let interrupted = false
    let error = null
    const round = () => {
      const last = rounds.at(-1)
      if (last && !last.notes && !last.answered) return last
      const next = { text: '', calls: [], answered: false }
      rounds.push(next)
      return next
    }

    // offered: pico's tools the agent has no version of its own. A call
    // through the bridge lands on the call the agent announced for it
    // (same name, oldest first), which may arrive just after the call itself
    const covered = host.ownTools ? new Set(host.ownTools) : ownTools
    const offered = tools.filter((tool) => !covered.has(tool.name)).map(offer)
    const unclaimed = []
    const claimWaiters = new Set()
    entry.bridge.setTurn(offered, async (name) => {
      const take = () => {
        const at = unclaimed.findIndex((call) => call.name === name)
        return at >= 0 ? unclaimed.splice(at, 1)[0] : null
      }
      let call = take()
      if (!call) {
        await new Promise((resolve) => {
          const waiter = () => { if ((call = take())) { claimWaiters.delete(waiter); resolve() } }
          claimWaiters.add(waiter)
          setTimeout(() => { claimWaiters.delete(waiter); resolve() }, CLAIM_WAIT_MS)
        })
      }
      recorder.currentCall = call ? { id: call.id } : null
    })

    // the agent's subagents, by the id of the call that started each,
    // shown in pico's activity list while they work, with their own
    // traffic; a subagent may start subagents of its own
    const subagents = new Map()
    const startSubagent = (update, spec) => {
      if (!host.subagents) return
      const handle = host.subagents.start({ description: spec.description, prompt: spec.prompt ?? '', model: spec.model ? `${provider}/${spec.model}` : `${provider}/${model}`, callId: update.toolCallId })
      subagents.set(update.toolCallId, { handle, said: '' })
    }
    const finishSubagent = (id, { failed: broke, text }) => {
      const sub = subagents.get(id)
      if (!sub) return
      subagents.delete(id)
      // what it found is its own last message, as it wrote it; the call's result only when it wrote none
      sub.handle.finish(broke ? { error: text || 'failed', interrupted } : { result: sub.said.trim() ? sub.said : text })
    }
    const subCalls = new Map()
    const onSubagentUpdate = (sub, update) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        sub.said += update.content.text
        sub.handle.event({ type: 'content', content: update.content.text })
      } else if (update.sessionUpdate === 'tool_call' && !subCalls.has(update.toolCallId)) {
        const { name, args, subagent } = toolOf(update, host.cwd)
        subCalls.set(update.toolCallId, update)
        sub.said = ''
        sub.handle.event({ type: 'tool_executing', call: { id: update.toolCallId, type: 'function', function: { name, arguments: JSON.stringify(args) } }, at: Date.now() })
        if (subagent) startSubagent(update, subagent)
      }
      if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && (update.status === 'completed' || update.status === 'failed')) {
        const merged = { ...subCalls.get(update.toolCallId), ...update }
        subCalls.delete(update.toolCallId)
        const text = resultText(merged)
        sub.handle.event(update.status === 'failed' ? { type: 'tool_error', call: { id: update.toolCallId }, error: text } : { type: 'tool_complete', call: { id: update.toolCallId }, result: text })
        finishSubagent(update.toolCallId, { failed: update.status === 'failed', text })
      }
    }

    const announce = (update) => {
      const { name, args, bridged, subagent } = toolOf(update, host.cwd)
      const call = { id: update.toolCallId, type: 'function', function: { name, arguments: JSON.stringify(args) } }
      const path = callPath(update)
      const state = { id: update.toolCallId, name, args, bridged: !!bridged, call, startedAt: Date.now(), path: null, before: null, update }
      if (path && changesFile(name)) { state.path = path; state.before = readText(path) }
      calls.set(update.toolCallId, state)
      round().calls.push(state)
      if (bridged) { unclaimed.push({ id: update.toolCallId, name }); for (const waiter of claimWaiters) waiter() }
      onStream({ type: 'tool_calls_ready', calls: [call] })
      onStream({ type: 'tool_executing', call })
      if (subagent) startSubagent(update, subagent)
    }

    // the change a finished call made to a file: the adapter's whole-file
    // diff where it has one, else the file as it was when the call was
    // announced and as it is now, else the snippets the agent reported
    const fileChange = (state, merged, shown) => {
      const [diff] = diffsOf(merged)
      if (picoMeta(merged).wholeFile && diff && typeof diff.newText === 'string') {
        const before = diff.oldText ?? null
        return { diff: makeDiff(shown, before ?? '', diff.newText), revert: makeWriteEdit(diff.path, before ?? '', diff.newText, before !== null), created: before === null }
      }
      const path = state.path ?? callPath(merged)
      if (state.path) {
        const after = readText(path)
        if (after !== state.before) return { diff: makeDiff(shown, state.before ?? '', after ?? ''), ...(after !== null ? { revert: makeWriteEdit(path, state.before ?? '', after, state.before !== null) } : {}), created: state.before === null }
      }
      return diff ? { diff: makeDiff(shown, diff.oldText ?? '', diff.newText ?? '') } : null
    }

    // a call the agent finished: its result into the history, and its row
    const settle = (state, update) => {
      calls.delete(state.id)
      const merged = { ...state.update, ...update, _meta: { ...state.update._meta, ...update._meta, pico: { ...picoMeta(state.update), ...picoMeta(update) } } }
      const broke = merged.status === 'failed'
      const text = resultText(merged)
      state.result = broke ? `Error: ${text || 'failed'}` : text
      const owner = rounds.find((r) => r.calls.includes(state))
      if (owner) owner.answered = true
      const at = unclaimed.findIndex((call) => call.id === state.id)
      if (at >= 0) unclaimed.splice(at, 1)
      finishSubagent(state.id, { failed: broke, text })
      if (!state.bridged || !recorder.entries.some((candidate) => candidate.callId === state.id)) {
        const row = {
          callId: state.id,
          name: state.name,
          args: state.args,
          title: typeof state.args.path === 'string' ? state.args.path : merged.title,
          description: state.args.description,
          status: broke ? (interrupted ? 'interrupted' : 'error') : 'done',
          durationMs: Date.now() - state.startedAt,
          fullOutput: text,
        }
        if (broke && !interrupted) row.error = text || 'failed'
        if (!broke && changesFile(state.name)) {
          const change = fileChange(state, merged, typeof state.args.path === 'string' ? state.args.path : callPath(merged))
          if (change?.diff) row.diff = change.diff
          if (change?.revert) row.revert = change.revert
          if (change?.created) row.created = true
        }
        recorder.entries.push(row)
      }
      onStream({ type: broke ? 'tool_error' : 'tool_complete', call: state.call, ...(broke ? { error: text } : { result: text }) })
    }

    // notes that arrived mid-turn reach the agent between tool rounds, as
    // a prompt sent while the turn runs, which the agent folds into it
    const prompts = []
    let delivery = null
    const deliverNotes = () => {
      if (interrupted || delivery || !beforeRequest || calls.size || !entry.conn) return
      delivery = (async () => {
        const notes = await beforeRequest()
        if (!notes?.length || interrupted || !entry.conn) return
        rounds.push({ notes })
        prompts.push(entry.conn.request('session/prompt', { sessionId: entry.sessionId, prompt: (await hydrateImages(notes)).flatMap(userBlocks) }))
      })().catch(() => {}).finally(() => { delivery = null })
    }

    entry.onNotification = (method, params) => {
      if (method !== 'session/update' || params.sessionId !== entry.sessionId) return
      const update = params.update ?? {}
      const parent = picoMeta(update).parentToolCallId
      if (parent && subagents.has(parent)) return onSubagentUpdate(subagents.get(parent), update)
      if (parent) return
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text' && update.content.text) { round().text += update.content.text; onStream({ type: 'content', content: update.content.text }) }
          break
        case 'agent_thought_chunk':
          if (update.content?.type === 'text' && update.content.text) onStream({ type: 'thinking', content: update.content.text })
          break
        case 'tool_call':
          if (!calls.has(update.toolCallId)) announce(update)
          else calls.get(update.toolCallId).update = { ...calls.get(update.toolCallId).update, ...update }
          if (update.status === 'completed' || update.status === 'failed') { settle(calls.get(update.toolCallId), update); deliverNotes() }
          break
        case 'tool_call_update': {
          const state = calls.get(update.toolCallId)
          if (!state) break
          state.update = { ...state.update, ...update }
          if (!state.path && changesFile(state.name) && callPath(update)) { state.path = callPath(update); state.before = readText(state.path) }
          if (update.status === 'completed' || update.status === 'failed') { settle(state, update); deliverNotes() }
          break
        }
        case 'usage_update':
          if (update.used) lastPrompt = update.used
          if (picoMeta(update).usage) { usage = picoMeta(update).usage; onStream({ type: 'usage', usage }) }
          break
        case 'config_option_update':
          if (Array.isArray(update.configOptions)) entry.configOptions = update.configOptions
          break
      }
    }

    // the agent asks for nothing pico would not allow; it asks the person
    // only what it means to ask them
    const askTool = tools.find((tool) => tool.name === 'ask_user')
    entry.onRequest = async (method, params) => {
      if (method !== 'session/request_permission') throw Object.assign(new Error(`pico does not handle ${method}`), { code: -32601 })
      const options = params.options ?? []
      if (picoMeta(params).question) {
        if (!askTool || interrupted) return { outcome: { outcome: 'cancelled' } }
        recorder.currentCall = { id: params.toolCall?.toolCallId }
        const answer = await askTool.execute({ questions: [questionOf(params)] }).catch(() => null)
        const chosen = chosenOption(answer, options)
        return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } }
      }
      const allow = allowOption(options)
      return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
    }

    let graceTimer = null
    let cleanupAbort = () => {}
    const ended = new Promise((resolve) => {
      entry.onExit = (exit) => {
        if (!interrupted) error = exit.error?.message || exit.stderr || `${label} stopped`
        resolve()
      }
      const onAbort = () => {
        interrupted = true
        entry.conn?.notify('session/cancel', { sessionId: entry.sessionId })
        graceTimer = setTimeout(() => { stop(entry); resolve() }, CANCEL_GRACE_MS)
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      cleanupAbort = () => signal?.removeEventListener('abort', onAbort)
    })

    // a reply's usage counts in full only where the agent did not already
    // report it as it went
    let reported = null
    const settlePrompt = (reply) => {
      if (reply?.usage) {
        const next = usageOf(reply.usage)
        reported = reported ? Object.fromEntries(Object.keys(next).map((k) => [k, reported[k] + next[k]])) : next
        if (!lastPrompt) lastPrompt = next.promptTokens
      }
      if (reply?.stopReason === 'refusal' && !interrupted) error = `${label} refused to go on; the plan's usage limit may have been reached`
    }
    const promptFailed = (failure) => { if (!interrupted) error = isSignInRequired(failure) ? signInRequired : String(failure.message || failure) }

    // the turn ends once the agent has answered every prompt it was sent
    prompts.push(entry.conn.request('session/prompt', { sessionId: entry.sessionId, prompt: content }))
    const allAnswered = (async () => {
      let answered = 0
      while (answered < prompts.length || delivery) {
        if (answered < prompts.length) await prompts[answered++].then(settlePrompt, promptFailed)
        else await delivery
      }
    })()
    await Promise.race([allAnswered, ended])
    clearTimeout(graceTimer)
    cleanupAbort()
    entry.onNotification = null
    entry.onRequest = null
    entry.onExit = null
    for (const waiter of claimWaiters) waiter()
    for (const sub of subagents.values()) sub.handle.finish({ interrupted: true })
    usage = reported ?? usage
    if (usage) onStream({ type: 'usage', usage })

    // the turn as pico history: each round's message, then its calls'
    // results; a call cut off by an interrupt still needs one, or the
    // history is invalid for whichever model reads it next
    const collected = []
    for (const r of rounds) {
      if (r.notes) { collected.push(...r.notes); continue }
      if (!r.text && !r.calls.length) continue
      collected.push({ role: 'assistant', content: r.text, ...(r.calls.length ? { tool_calls: r.calls.map((c) => c.call) } : {}) })
      for (const c of r.calls) collected.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? '[interrupted before it finished]' })
    }

    if (entry.conn) {
      entry.synced = fingerprint([...history, ...collected])
      entry.idle = setTimeout(() => stop(entry), idleMs)
      entry.idle.unref?.()
    } else {
      // the agent stopped: what it kept may not match, so the next turn
      // starts over from pico's history
      entry.sessionId = null
      entry.synced = null
    }
    return {
      messages: collected,
      usage,
      lastPromptTokens: lastPrompt,
      interrupted: interrupted || !!error,
      stalled: false,
      ...(error ? { error } : {}),
      engineState: { sessionId: entry.sessionId, owner: entry.owner, synced: entry.synced },
    }
  }

  // one question answered as text by a session of its own, with no tool
  // allowed and nothing kept afterward; `system` is added to the agent's
  // own instructions
  async function ask({ modelName, system = '', prompt, effort = null, signal, onStream = () => {} }) {
    let text = ''
    let sessionId = null
    let exit = null
    const conn = connect({
      cwd: process.cwd(),
      onNotification: (method, params) => {
        const update = params.update ?? {}
        if (method === 'session/update' && params.sessionId === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !picoMeta(update).parentToolCallId) {
          text += update.content.text
          onStream({ type: 'content', content: update.content.text })
        }
      },
      onRequest: async (method) => {
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
        throw Object.assign(new Error(`pico does not handle ${method}`), { code: -32601 })
      },
      onExit: (e) => { exit = e },
    })
    const onAbort = () => conn.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await initialize(conn)
      const session = await conn.request('session/new', { cwd: process.cwd(), mcpServers: [], _meta: { pico: { ephemeral: true, ...(system ? { systemPrompt: system } : {}) } } })
        .catch((error) => { throw isSignInRequired(error) ? new Error(signInRequired) : error })
      sessionId = session.sessionId
      await configure({ conn, sessionId, configOptions: session.configOptions ?? [] }, local(modelName), effort)
      await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
    } catch (error) {
      if (signal?.aborted) throw new Error('cancelled')
      throw exit?.error ?? error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (sessionId) await conn.request('session/close', { sessionId }).catch(() => {})
      conn.close()
    }
    return text.trim()
  }

  // pico's compaction, done by the same model: one bare run that reads the
  // conversation and writes the summary
  function compact({ history, modelName, prompt, signal, onStream }) {
    return ask({ modelName, prompt: `<transcript>\n${transcriptText(history)}\n</transcript>\n\n${prompt}`, signal, onStream })
      .catch((error) => { throw signal?.aborted ? new Error('compaction cancelled') : error })
  }

  return {
    name: provider,
    // these agents compact their own context as it fills; pico compacting
    // too would only restart their session from a summary
    autoCompact: false,
    run,
    ask,
    compact,
    // the pico session is done with: its connection and bridge go
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
