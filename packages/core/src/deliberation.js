import { resultText } from './agents.js'

export const DEFAULT_DELIBERATION_ROUNDS = 3
export const MAX_DELIBERATION_ROUNDS = 5
export const INITIAL_PARALLEL_GROUP = 'initial'
export const PARTICIPANT_ROLES = ['participant-a', 'participant-b']

export function validateDeliberation({ brief, rounds = DEFAULT_DELIBERATION_ROUNDS } = {}) {
  if (!brief?.trim()) throw new Error('deliberation brief is required')
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_DELIBERATION_ROUNDS) {
    throw new Error(`deliberation rounds must be between 1 and ${MAX_DELIBERATION_ROUNDS}`)
  }
  return { brief: brief.trim(), rounds }
}

function participantPrompt(brief, role, rounds) {
  const name = role === 'participant-a' ? 'Participant A' : 'Participant B'
  return `You are ${name}, one of two equal participants. Independently investigate and reason about this decision. This is a ${rounds}-round deliberation about the following decision:\n\n${brief}\n\nResearch before making claims. Use the available project and web tools whenever they can replace assumption with evidence. Cite URLs and project paths in your response. Challenge weak premises and address the peer's strongest points once their work is available. Do not seek agreement for its own sake or defend a fixed position. Change your position only when evidence warrants it, and preserve material disagreement and uncertainty. Do not modify project files. Write your own argument and reasoning; never instruct the other participant what to say or conclude. Be concise.`
}

function peerMessage(role, text, round, rounds) {
  const name = role === 'participant-a' ? 'Participant A' : 'Participant B'
  return `Round ${round} of ${rounds}. ${name} replied:\n\n${text}\n\nResearch and respond to the substance of this message.`
}

function synthesisPrompt(brief, turns) {
  const transcript = turns.map((turn) => `Round ${turn.round}, ${turn.role}:\n${turn.text}`).join('\n\n')
  return `Synthesize this deliberation into a decision for the main agent. State the recommendation, decisive evidence, unresolved uncertainty, material disagreement, and implementation constraints. Do not manufacture consensus: preserve disagreements that the evidence did not resolve. Preserve useful URLs and project paths. Do not mention the deliberation process unless disagreement remains.\n\nDecision brief:\n${brief}\n\nTranscript:\n${transcript}`
}

function settledTurn(result, role, round, parallelGroup) {
  if (result.error) return { error: result.error }
  const text = resultText(result.messages)
  if (result.interrupted || !text) return { error: text ? null : 'deliberation participant returned no response' }
  return { turn: { role, round, text, messages: result.messages || [], usage: result.usage || null, ...(parallelGroup ? { parallelGroup } : {}) } }
}

export async function runDeliberation({ brief, rounds, runParticipant, runSynthesis, onEvent = () => {}, signal }) {
  const valid = validateDeliberation({ brief, rounds })
  const participants = Object.fromEntries(PARTICIPANT_ROLES.map((role) => [role, [{ role: 'user', content: participantPrompt(valid.brief, role, valid.rounds) }]]))
  const turns = []

  if (signal?.aborted) return { turns, interrupted: true }
  const initialController = new AbortController()
  const abortInitial = () => initialController.abort(signal?.reason)
  signal?.addEventListener('abort', abortInitial, { once: true })
  let failure
  await Promise.allSettled(PARTICIPANT_ROLES.map(async (role) => {
    try {
      const result = await runParticipant({
        role, round: 1, rounds: valid.rounds, history: [...participants[role]],
        signal: initialController.signal, parallelGroup: INITIAL_PARALLEL_GROUP,
      })
      const parsed = settledTurn(result, role, 1, INITIAL_PARALLEL_GROUP)
      if (!parsed.turn) {
        failure ??= { interrupted: true, error: parsed.error }
        initialController.abort()
        return
      }
      participants[role].push(...(result.messages || []))
      turns.push(parsed.turn)
      onEvent({ type: 'deliberation_turn', ...parsed.turn })
    } catch (error) {
      failure ??= { interrupted: true, error: error?.message || String(error) }
      initialController.abort(error)
    }
  }))
  signal?.removeEventListener('abort', abortInitial)
  turns.sort((a, b) => PARTICIPANT_ROLES.indexOf(a.role) - PARTICIPANT_ROLES.indexOf(b.role))
  if (failure) return { turns, ...failure }
  if (signal?.aborted) return { turns, interrupted: true }

  participants['participant-b'].push({ role: 'user', content: peerMessage('participant-a', turns[0].text, 1, valid.rounds) })
  let peer = turns.at(-1)
  for (let round = 2; round <= valid.rounds; round++) {
    for (const role of PARTICIPANT_ROLES) {
      if (signal?.aborted) return { turns, interrupted: true }
      const history = participants[role]
      history.push({ role: 'user', content: peerMessage(peer.role, peer.text, round, valid.rounds) })
      const result = await runParticipant({ role, round, rounds: valid.rounds, history: [...history], signal })
      history.push(...(result.messages || []))
      const parsed = settledTurn(result, role, round)
      if (!parsed.turn) return { turns, interrupted: true, error: parsed.error }
      turns.push(parsed.turn)
      peer = parsed.turn
      onEvent({ type: 'deliberation_turn', ...parsed.turn })
    }
  }

  if (signal?.aborted) return { turns, interrupted: true }
  const synthesis = await runSynthesis({ history: [{ role: 'user', content: synthesisPrompt(valid.brief, turns) }], signal })
  return { turns, result: resultText(synthesis.messages), usage: synthesis.usage || null, interrupted: !!synthesis.interrupted, error: synthesis.error || null }
}
