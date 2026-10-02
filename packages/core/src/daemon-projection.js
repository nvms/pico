import { plain } from './daemon-wire.js'

export const defaultTranscriptLimit = 100
const stateExcluded = new Set(['events', 'persisted', 'derived', 'attachments', 'rewindUndo'])
const derivedExcluded = new Set(['transcript', 'providerHistory', 'historyEventIds', 'loadedContext', 'toolItems', 'peerMessages', 'consumedPeerIds', 'pendingPeerMessages', 'deferredConsumedPeers', 'openToolCalls', 'trimmedToolIds', 'toolTrimVersions'])
const agentExcluded = new Set(['events', 'timeline', 'options', 'controller', 'done', 'resolve'])
const select = (value, excluded) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !excluded.has(key)))

export function createProjection() {
  const clones = new WeakMap()
  const derivedCache = new WeakMap()
  const windows = new WeakMap()
  function immutable(value) {
    if (!value || typeof value !== 'object') return plain(value)
    if (!clones.has(value)) clones.set(value, plain(value))
    return clones.get(value)
  }
  return {
    state(source, limit = defaultTranscriptLimit) {
      const derived = source.derived || {}
      if (!derivedCache.has(derived)) derivedCache.set(derived, plain(select(derived, derivedExcluded)))
      const transcript = derived.transcript || []
      let byLimit = windows.get(derived)
      if (!byLimit) windows.set(derived, byLimit = new Map())
      const offset = Math.max(0, transcript.length - limit)
      if (!byLimit.has(limit)) byLimit.set(limit, transcript.slice(offset).map(immutable))
      const attachments = new Map([...source.attachments || []].map(([key, value]) => [key, plain(Object.fromEntries(['kind', 'path', 'mediaType', 'hash', 'subject', 'root', 'url', 'selector', 'tag', 'component', 'fromLine', 'toLine', 'fromColumn', 'toColumn'].filter(k => value[k] !== undefined).map(k => [k, value[k]])))]))
      return { ...plain(select(source, stateExcluded)), attachments, rewindUndo: !!source.rewindUndo, derived: { ...derivedCache.get(derived), transcript: byLimit.get(limit), transcriptOffset: offset, transcriptTotal: transcript.length } }
    },
    agents(values) {
      return values.map(value => ({ ...plain(select(value, agentExcluded)), ...(value.timeline ? { timeline: value.timeline.map(immutable) } : {}), events: (value.events || []).filter(event => ['content', 'tool_executing', 'tool_complete', 'tool_error'].includes(event.type)).map(immutable) }))
    },
  }
}
