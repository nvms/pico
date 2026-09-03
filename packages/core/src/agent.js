import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { compose, scope, model, noToolsCalled, Inherit, getText } from '@prsm/ai'
import { commitLabel, elementLabel, fileLabel, mediaTypeFor, selectionLabel } from './attachments.js'

const exec = promisify(execFile)
// a whole patch rides along only while it is small; a bigger commit
// arrives as its header and stat, and the model pulls the files it cares
// about with git show. 8KB is a couple of thousand tokens
const COMMIT_PATCH_LIMIT = 8 * 1024
const COMMIT_STAT_FILES = 80
const GIT_SHOW = ['--no-optional-locks', 'show', '--format=%H%nAuthor: %an <%ae>%nDate: %ad%n%n%B']

function trimStat(stat) {
  const lines = stat.trimEnd().split('\n')
  if (lines.length <= COMMIT_STAT_FILES + 1) return stat.trimEnd()
  return [...lines.slice(0, COMMIT_STAT_FILES), `... ${lines.length - COMMIT_STAT_FILES - 1} more files`, lines.at(-1)].join('\n')
}

export async function hydrateCommit(part) {
  const head = commitLabel(part)
  const options = { cwd: part.root, maxBuffer: 64 * 1024 * 1024 }
  try {
    const { stdout: full } = await exec('git', [...GIT_SHOW, '--stat', '--patch', part.hash], options)
    if (full.length <= COMMIT_PATCH_LIMIT) return { type: 'text', text: `${head}\n${full.trimEnd()}\n[/commit]` }
    const { stdout: stat } = await exec('git', [...GIT_SHOW, '--stat', part.hash], options)
    const note = `[patch omitted: ${Math.round(full.length / 1024)}KB; run git show ${part.hash.slice(0, 7)} -- <path> for the files you need]`
    return { type: 'text', text: `${head}\n${trimStat(stat)}\n${note}\n[/commit]` }
  } catch {
    return { type: 'text', text: `${head}\n[commit unavailable]\n[/commit]` }
  }
}

// file parts reach the model as a labelled path; it reads them itself
async function hydratePart(part) {
  if (part.type === 'file') return { type: 'text', text: fileLabel(part.path) }
  if (part.type === 'selection') return { type: 'text', text: selectionLabel(part) }
  if (part.type === 'commit') return hydrateCommit(part)
  if (part.type === 'element') return { type: 'text', text: elementLabel(part) }
  if (part.type !== 'image' || part.source?.kind !== 'path') return part
  const mediaType = part.source.mediaType || mediaTypeFor(part.source.path)
  if (!mediaType) return { type: 'text', text: `[image unavailable: ${part.source.path}]` }
  try {
    const data = await readFile(part.source.path)
    return {
      type: 'image',
      source: { kind: 'base64', mediaType, data: data.toString('base64') },
    }
  } catch {
    return { type: 'text', text: `[image unavailable: ${part.source.path}]` }
  }
}

export function hydrateImages(history) {
  return Promise.all(
    history.map(async (message) =>
      Array.isArray(message.content)
        ? { ...message, content: await Promise.all(message.content.map(hydratePart)) }
        : message,
    ),
  )
}

// reasoning models with large contexts can sit minutes before the first
// output token; this guards against truly dead streams, not slow ones
const STALL_MS = 300000

export function compactionHistory(history, prompt) {
  return hydrateImages([...history.filter((m) => m.role !== 'system'), { role: 'user', content: prompt }])
}

export async function compactHistory({ history, modelName, auth, prompt, signal, onStream }) {
  const out = await compose(
    model({
      model: modelName,
      ...(auth?.apiKey && { apiKey: auth.apiKey }),
      ...(auth?.headers && { headers: auth.headers }),
    }),
  )({
    history: await compactionHistory(history, prompt),
    tools: [],
    abortSignal: signal,
    ...(onStream && { stream: onStream }),
  })
  if (signal?.aborted) throw new Error('compaction cancelled')
  return getText(out.lastResponse?.content || '').trim()
}

// the summary has a fixed shape: an <analysis> scratchpad, then 8 numbered
// sections; watching headers stream by is real progress, not an estimate
export function compactProgress(streamed) {
  const chars = streamed.length
  const afterAnalysis = streamed.split('</analysis>')[1] ?? streamed.split('<summary>')[1]
  if (afterAnalysis === undefined) return { phase: 'analyzing', section: 0, chars }
  const sections = (afterAnalysis.match(/^\s*\d+\.\s/gm) || []).length
  if (sections === 0) return { phase: 'analyzing', section: 0, chars }
  return { phase: 'writing', section: Math.min(8, sections), chars }
}

export async function summarizeText({ text, modelName, auth }) {
  const out = await compose(
    model({
      model: modelName,
      system: 'Summarize the following conversation excerpt in 2-4 dense sentences. Capture decisions, changes made, and open questions. Output only the summary.',
      ...(auth?.apiKey && { apiKey: auth.apiKey }),
      ...(auth?.headers && { headers: auth.headers }),
    }),
  )(text.slice(0, 30000))
  return getText(out.lastResponse?.content || '').trim()
}

export async function runTurn({ history, tools, recorder, modelName, effort, auth, system, signal, onStream, stallMs = STALL_MS }) {
  const collected = []
  let roundText = ''
  let usageSeen = null
  let stalled = false
  // usage events carry cumulative totals per request round, so consecutive
  // deltas recover each round's true input size; the last delta is the size
  // of the current context as actually sent
  let cumulativePrompt = 0
  let lastPromptTokens = 0

  const internal = new AbortController()
  const onUserAbort = () => internal.abort()
  if (signal?.aborted) internal.abort()
  else signal?.addEventListener('abort', onUserAbort, { once: true })

  let watchdog = null
  const arm = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      stalled = true
      internal.abort()
    }, stallMs)
  }

  const stream = (event) => {
    if (event.type === 'tool_executing') {
      // a tool may legitimately run for minutes (test suites, slow fetches)
      // and emits nothing while it does; the watchdog guards the provider
      // stream, so pause it until the tool finishes. tools carry their own
      // timeouts (bash 120s default, web tools via dredge)
      clearTimeout(watchdog)
      recorder.currentCall = event.call
      onStream?.(event)
      return
    }
    arm()
    if (event.type === 'content') {
      roundText += event.content
    } else if (event.type === 'tool_calls_ready') {
      collected.push({ role: 'assistant', content: roundText, tool_calls: event.calls })
      roundText = ''
    } else if (event.type === 'tool_complete') {
      collected.push({ role: 'tool', tool_call_id: event.call.id, content: JSON.stringify(event.result) })
    } else if (event.type === 'tool_error') {
      collected.push({ role: 'tool', tool_call_id: event.call.id, content: JSON.stringify({ error: event.error }) })
    } else if (event.type === 'usage') {
      usageSeen = event.usage
      const prompt = event.usage?.promptTokens || 0
      lastPromptTokens = Math.max(0, prompt - cumulativePrompt)
      cumulativePrompt = prompt
    }
    onStream?.(event)
  }

  const base = history.length
  const step = compose(
    scope(
      { inherit: Inherit.Conversation, system, tools, until: noToolsCalled(), stream },
      (ctx) =>
        model({
          model: modelName,
          ...(effort && { effort }),
          ...(auth?.apiKey && { apiKey: auth.apiKey }),
          ...(auth?.headers && { headers: auth.headers }),
        })({ ...ctx, abortSignal: internal.signal }),
    ),
  )

  const partialMessages = () => {
    const messages = [...collected]
    if (roundText) messages.push({ role: 'assistant', content: roundText })
    return messages
  }

  arm()
  try {
    const out = await step({ history: await hydrateImages(history), tools: [] })
    const interrupted = !!signal?.aborted || stalled
    if (interrupted) {
      return { messages: partialMessages(), usage: usageSeen, lastPromptTokens, interrupted, stalled }
    }
    const messages = out.history.filter((m) => m.role !== 'system').slice(base)
    return { messages, usage: out.usage || null, lastPromptTokens, interrupted: false, stalled: false }
  } catch (err) {
    if (err.name === 'AbortError' || internal.signal.aborted) {
      return { messages: partialMessages(), usage: usageSeen, lastPromptTokens, interrupted: true, stalled }
    }
    // a provider error mid-turn must not discard the rounds that already
    // ran: tools mutated the world, so the record has to survive
    return { messages: partialMessages(), usage: usageSeen, lastPromptTokens, interrupted: true, stalled: false, error: String(err.message || err) }
  } finally {
    clearTimeout(watchdog)
    signal?.removeEventListener('abort', onUserAbort)
  }
}
