import { join } from 'node:path'
import { discoverKeys, applyKeys } from './core/keys.js'
import { loadCatalog, extractModels, adhocModel } from './core/catalog.js'
import { loadCodexModels } from './core/codex-models.js'
import { openaiConnected, openaiCredentials } from './core/openai-auth.js'
import { findModel, defaultModel, estimateCost } from './core/models.js'
import { readConfig } from './core/config.js'
import { buildProjectBoot } from './core/boot.js'
import { createShellManager } from './core/shells.js'
import { createSession, openSession, loadSession } from './core/session.js'
import { sessionsDir } from './core/paths.js'
import { makeEvent } from './core/events.js'
import { deriveState } from './core/derive.js'
import { createToolset } from './core/tools/index.js'
import { resolveDredge } from './core/tools/web.js'
import { runTurn } from './core/agent.js'
import { buildSystemPrompt } from './core/system-prompt.js'
import { memoryIndex } from './core/memory.js'
import { fuzzyScore } from './ui/fuzzy.js'
import { finalizeUserContent } from './ui/attachments.js'

function resolveModel(models, providers, name) {
  if (!name) return null
  const exact = models.find((m) => m.name === name)
  if (exact) return exact
  if (name.includes('/')) return adhocModel(name, providers)
  const scored = models
    .filter((m) => m.available !== false)
    .map((m) => [fuzzyScore(name, m.name), m])
    .filter(([score]) => score >= 0)
    .sort((a, b) => b[0] - a[0])
  return scored[0]?.[1] || null
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
    if (data.length > 400000) break
  }
  return data.slice(0, 400000)
}

export async function runHeadless(opts) {
  const startedAt = Date.now()
  const log = opts.quiet ? () => {} : (line) => process.stderr.write(line + '\n')

  const chatgpt = await openaiConnected()
  const providers = [...applyKeys(discoverKeys()), ...(chatgpt ? ['codex'] : [])]
  if (providers.length === 0) {
    process.stderr.write('pico: no credentials found (set a provider key or run pico --connect)\n')
    return 1
  }
  const catalogData = await loadCatalog()
  const codexCreds = chatgpt ? await openaiCredentials().catch(() => null) : null
  const models = [
    ...extractModels(catalogData, ['google', 'anthropic', 'openai', 'xai']).map((m) => ({
      ...m,
      available: providers.includes(m.provider),
    })),
    ...(await loadCodexModels(codexCreds)).map((m) => ({ ...m, available: chatgpt })),
  ]
  const config = await readConfig()

  const model = resolveModel(models, providers, opts.model)
    || (config.defaultModel && models.find((m) => m.name === config.defaultModel && m.available))
    || defaultModel(models)
  if (!model || model.available === false) {
    process.stderr.write(`pico: no usable model${opts.model ? ` matching "${opts.model}"` : ''}\n`)
    return 1
  }
  const effort = opts.effort ?? (model.effort ? 'auto' : null)

  const boot = await buildProjectBoot(process.cwd())
  await Promise.race([boot.mcp.connectAll(), new Promise((r) => setTimeout(r, 10000))])
  const shells = createShellManager()

  let session
  let events = []
  if (opts.resume) {
    const file = opts.resume.includes('/') ? opts.resume : join(sessionsDir(boot.root), `${opts.resume}.jsonl`)
    const loaded = await loadSession(file)
    session = openSession({ file, header: loaded.header })
    events = loaded.events
  } else {
    session = createSession({ cwd: boot.cwd, root: boot.root })
  }

  const persist = (event) => {
    events.push(event)
    session.append(event)
    if (opts.streamJson) process.stdout.write(JSON.stringify(event) + '\n')
  }

  const stdinData = await readStdin()
  const promptText = stdinData ? `${opts.prompt}\n\n[piped input]\n${stdinData}` : opts.prompt
  const { content } = finalizeUserContent(promptText, new Map())
  persist(makeEvent('message', { message: { role: 'user', content } }))

  const derived = deriveState(events)
  const loadedBefore = new Set(boot.tracker.loaded)
  const { tools, recorder } = createToolset({
    cwd: boot.cwd,
    tracker: boot.tracker,
    skills: boot.skills,
    shells,
    memory: boot.memory,
    dredge: resolveDredge(config),
    mcpTools: boot.mcp.tools(),
    userTools: [],
    maxToolCalls: opts.maxToolCalls ?? 50,
  })

  let auth = null
  if (model.provider === 'codex') {
    auth = await openaiCredentials().catch(() => null)
    if (!auth) {
      process.stderr.write('pico: codex models need a ChatGPT sign-in (run pico --connect)\n')
      return 1
    }
  }

  log(`pico · ${model.name}${effort ? ` · ${effort}` : ''} · session ${session.id}`)
  let thoughts = ''
  const result = await runTurn({
    history: derived.providerHistory,
    tools,
    recorder,
    modelName: model.name,
    effort,
    auth,
    system: buildSystemPrompt({
      cwd: boot.cwd,
      contextFiles: boot.startupContext.files,
      skills: boot.skills.list(),
      memoryIndexText: memoryIndex(await boot.memory.list().catch(() => []), boot.root),
    }),
    onStream: (event) => {
      if (event.type === 'thinking') thoughts += event.content
      if (event.type === 'tool_complete') {
        const entry = recorder.entries.at(-1)
        log(`  ✓ ${entry?.name ?? event.call.function.name}  ${entry?.title ?? ''}`)
      }
      if (event.type === 'tool_error') log(`  ✗ ${event.call.function.name}  ${event.error.slice(0, 120)}`)
    },
  })

  if (thoughts) persist(makeEvent('thoughts', { text: thoughts }))
  for (const message of result.messages) persist(makeEvent('message', { message }))
  for (const entry of recorder.entries) persist(makeEvent('tool_meta', entry))
  for (const path of boot.tracker.loaded) {
    if (!loadedBefore.has(path)) persist(makeEvent('context_file', { path }))
  }
  if (result.usage) persist(makeEvent('usage', { model: model.name, usage: result.usage, lastPrompt: result.lastPromptTokens }))
  if (result.interrupted) persist(makeEvent('interrupt', {}))

  const running = shells.running()
  if (running > 0) log(`  killing ${running} background shell${running === 1 ? '' : 's'}`)
  shells.killAll()
  await boot.mcp.closeAll().catch(() => {})

  const text = result.messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content).at(-1)?.content ?? ''
  const summary = {
    text,
    session: session.id,
    sessionFile: session.file,
    model: model.name,
    usage: result.usage,
    cost: estimateCost(findModel(models, model.name), result.usage),
    toolCalls: recorder.entries.length,
    interrupted: result.interrupted,
    durationMs: Date.now() - startedAt,
  }

  if (opts.json) process.stdout.write(JSON.stringify(summary) + '\n')
  else if (opts.streamJson) process.stdout.write(JSON.stringify({ type: 'result', ...summary, text: undefined, at: Date.now() }) + '\n')
  else process.stdout.write(text + '\n')

  return result.interrupted ? 1 : 0
}
