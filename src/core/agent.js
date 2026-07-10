import { readFile } from 'node:fs/promises'
import { compose, scope, model, noToolsCalled, Inherit, getText } from '@prsm/ai'

async function hydratePart(part) {
  if (part.type !== 'image' || part.source?.kind !== 'path') return part
  try {
    const data = await readFile(part.source.path)
    return {
      type: 'image',
      source: { kind: 'base64', mediaType: part.source.mediaType, data: data.toString('base64') },
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

const STALL_MS = 90000

export async function compactHistory({ history, modelName, auth, prompt, signal, onStream }) {
  const out = await compose(
    model({
      model: modelName,
      ...(auth?.apiKey && { apiKey: auth.apiKey }),
      ...(auth?.headers && { headers: auth.headers }),
    }),
  )({
    history: [...history.filter((m) => m.role !== 'system'), { role: 'user', content: prompt }],
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

export async function summarizeText({ text, modelName }) {
  const out = await compose(
    model({
      model: modelName,
      system: 'Summarize the following conversation excerpt in 2-4 dense sentences. Capture decisions, changes made, and open questions. Output only the summary.',
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
    arm()
    if (event.type === 'content') {
      roundText += event.content
    } else if (event.type === 'tool_calls_ready') {
      collected.push({ role: 'assistant', content: roundText, tool_calls: event.calls })
      roundText = ''
    } else if (event.type === 'tool_executing') {
      recorder.currentCall = event.call
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
    throw err
  } finally {
    clearTimeout(watchdog)
    signal?.removeEventListener('abort', onUserAbort)
  }
}
