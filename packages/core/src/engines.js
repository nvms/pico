// Turn engines. A turn normally runs through runTurn, which calls the
// model's provider API with pico's tools and history. An engine replaces
// that for the models of one provider: it takes the same turn arguments,
// emits the same stream events and returns provider-shaped messages, so
// the controller, session log, transcript, peers and tools work the same
// whichever engine ran the turn.
//
// An engine is { name, run, compact, autoCompact?, release? }. `run` also
// receives `host` (the pico session id, cwd, env, context files, and the
// engine's own state saved with the session) and may return `engineState`
// to be saved. `release(sessionId)` frees what an engine holds for a
// session that has shut down.

import { createClaudeCodeEngine } from './claude-code/engine.js'
import { CLAUDE_CODE_PROVIDER } from './claude-code/models.js'

const factories = { [CLAUDE_CODE_PROVIDER]: createClaudeCodeEngine }
const engines = new Map()

export function engineFor(model) {
  const provider = model?.provider
  if (!factories[provider]) return null
  if (!engines.has(provider)) engines.set(provider, factories[provider]())
  return engines.get(provider)
}

export function releaseEngines(sessionId) {
  for (const engine of engines.values()) engine.release?.(sessionId)
}
