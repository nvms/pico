const ALGORITHM = 'tool-trim-v1'
const ARGUMENT_CHARS = 8000
const RESULT_CHARS = 12000
const STRING_CHARS = 6000
const ARRAY_ITEMS = 40
const OBJECT_KEYS = 80
const HEAD_RATIO = 0.6

function truncateText(value, limit, label = 'content') {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const marker = `\n[${label} omitted: ${text.length - limit} or more chars]\n`
  const available = Math.max(0, limit - marker.length)
  const head = Math.floor(available * HEAD_RATIO)
  return text.slice(0, head) + marker + text.slice(text.length - (available - head))
}

function boundedValue(value, depth = 0) {
  if (typeof value === 'string') return truncateText(value, STRING_CHARS)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8) return '[nested value omitted]'
  if (Array.isArray(value)) {
    if (value.length <= ARRAY_ITEMS) return value.map((item) => boundedValue(item, depth + 1))
    const head = Math.ceil(ARRAY_ITEMS * HEAD_RATIO)
    const tail = ARRAY_ITEMS - head
    return [
      ...value.slice(0, head).map((item) => boundedValue(item, depth + 1)),
      `[${value.length - ARRAY_ITEMS} array items omitted]`,
      ...value.slice(-tail).map((item) => boundedValue(item, depth + 1)),
    ]
  }
  const entries = Object.entries(value)
  const kept = entries.length <= OBJECT_KEYS
    ? entries
    : [...entries.slice(0, Math.ceil(OBJECT_KEYS * HEAD_RATIO)), ['_trimmed', `${entries.length - OBJECT_KEYS} object fields omitted`], ...entries.slice(-(OBJECT_KEYS - Math.ceil(OBJECT_KEYS * HEAD_RATIO)))]
  return Object.fromEntries(kept.map(([key, item]) => [key, boundedValue(item, depth + 1)]))
}

function importantArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(['description', 'name', 'outcome'].filter((key) => key in value).map((key) => [key, boundedValue(value[key])]))
}

function trimArguments(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = { _raw: String(raw ?? '') }
  }
  let bounded = boundedValue(parsed)
  let encoded = JSON.stringify(bounded)
  if (encoded.length <= ARGUMENT_CHARS) return encoded
  const important = importantArguments(parsed)
  let previewLimit = ARGUMENT_CHARS
  while (previewLimit > 0) {
    encoded = JSON.stringify({ ...important, _trimmed: truncateText(JSON.stringify(parsed), previewLimit, 'arguments') })
    if (encoded.length <= ARGUMENT_CHARS) return encoded
    previewLimit = Math.floor(previewLimit / 2)
  }
  return JSON.stringify({ _trimmed: truncateText(JSON.stringify(parsed), 1000, 'arguments') })
}

function isImagePart(part) {
  return part && typeof part === 'object' && (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image' || part.source?.type === 'base64')
}

function trimResult(content) {
  if (!Array.isArray(content)) return truncateText(content, RESULT_CHARS, 'tool result')
  const safe = content.map((part) => isImagePart(part)
    ? { type: 'text', text: '[tool image omitted to save context]' }
    : boundedValue(part))
  const encoded = JSON.stringify(safe)
  return encoded.length <= RESULT_CHARS
    ? safe
    : [{ type: 'text', text: truncateText(encoded, RESULT_CHARS, 'tool result') }]
}

function callsIn(history) {
  const calls = new Map()
  history.forEach((message, index) => {
    for (const call of message.tool_calls || []) calls.set(call.id, { call, callIndex: index, result: null, resultIndex: -1 })
    if (message.role === 'tool') {
      const entry = calls.get(message.tool_call_id)
      if (entry) Object.assign(entry, { result: message, resultIndex: index })
    }
  })
  return calls
}

export function completedToolCalls(history) {
  return new Map([...callsIn(history)].filter(([, entry]) => entry.result))
}

export function applyToolTrims(history, trimmedIds) {
  if (!trimmedIds.size) return history
  const completed = completedToolCalls(history)
  const callMessages = new Map()
  const resultMessages = new Map()
  for (const id of trimmedIds) {
    const entry = completed.get(id)
    if (!entry) continue
    let callMessage = callMessages.get(entry.callIndex)
    if (!callMessage) {
      callMessage = { ...history[entry.callIndex], tool_calls: history[entry.callIndex].tool_calls.map((call) => ({ ...call, function: { ...call.function } })) }
      callMessages.set(entry.callIndex, callMessage)
    }
    const call = callMessage.tool_calls.find((candidate) => candidate.id === id)
    call.function.arguments = trimArguments(call.function.arguments)
    resultMessages.set(entry.resultIndex, { ...entry.result, content: trimResult(entry.result.content) })
  }
  return history.map((message, index) => callMessages.get(index) || resultMessages.get(index) || message)
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n')
  return JSON.stringify(content ?? '')
}

export function annotateToolContext(state, effectiveHistory, trimmedIds) {
  const completed = completedToolCalls(effectiveHistory)
  for (const item of state.toolItems.values()) {
    const entry = completed.get(item.callId)
    item.contextAvailable = !!entry
    item.contextTrimmed = !!entry && trimmedIds.has(item.callId)
    item.contextTokens = entry
      ? Math.ceil((String(entry.call.function.arguments ?? '').length + resultText(entry.result.content).length) / 4)
      : 0
  }
}

export const TOOL_TRIM_VERSION = {
  algorithm: ALGORITHM,
  argumentChars: ARGUMENT_CHARS,
  resultChars: RESULT_CHARS,
  stringChars: STRING_CHARS,
}
