import { resultText } from './agents.js'

export const DEFAULT_DELIBERATION_ROUNDS = 3
export const MAX_DELIBERATION_ROUNDS = 5

export function validateDeliberation({ brief, rounds = DEFAULT_DELIBERATION_ROUNDS } = {}) {
  if (!brief?.trim()) throw new Error('deliberation brief is required')
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_DELIBERATION_ROUNDS) {
    throw new Error(`deliberation rounds must be between 1 and ${MAX_DELIBERATION_ROUNDS}`)
  }
  return { brief: brief.trim(), rounds }
}

function participantPrompt(brief, role, rounds) {
  return `You are the ${role} in a ${rounds}-round deliberation about the following decision:\n\n${brief}\n\nResearch before making claims. Use the available project and web tools whenever they can replace assumption with evidence. Cite URLs and project paths in your response. Challenge weak premises, address the peer's strongest points, and work toward the best decision rather than defending a fixed position. Do not modify project files. Return a concise message addressed to the other participant.`
}

function peerMessage(role, text, round, rounds) {
  return `Round ${round} of ${rounds}. The ${role} replied:\n\n${text}\n\nResearch and respond to the substance of this message.`
}

function synthesisPrompt(brief, turns) {
  const transcript = turns.map((turn) => `Round ${turn.round}, ${turn.role}:\n${turn.text}`).join('\n\n')
  return `Synthesize this deliberation into a decision for the main agent. State the recommendation, decisive evidence, unresolved uncertainty, and implementation constraints. Preserve useful URLs and project paths. Do not mention the deliberation process unless disagreement remains.\n\nDecision brief:\n${brief}\n\nTranscript:\n${transcript}`
}

export async function runDeliberation({ brief, rounds, runParticipant, runSynthesis, onEvent = () => {}, signal }) {
  const valid = validateDeliberation({ brief, rounds })
  const participants = {
    proposer: [{ role: 'user', content: participantPrompt(valid.brief, 'proposer', valid.rounds) }],
    reviewer: [{ role: 'user', content: participantPrompt(valid.brief, 'reviewer', valid.rounds) }],
  }
  const turns = []
  let peer = null

  for (let round = 1; round <= valid.rounds; round++) {
    for (const role of ['proposer', 'reviewer']) {
      if (signal?.aborted) return { turns, interrupted: true }
      const history = participants[role]
      if (peer) history.push({ role: 'user', content: peerMessage(peer.role, peer.text, round, valid.rounds) })
      const result = await runParticipant({ role, round, rounds: valid.rounds, history: [...history], signal })
      history.push(...(result.messages || []))
      const text = resultText(result.messages)
      if (result.error) return { turns, interrupted: true, error: result.error }
      if (result.interrupted || !text) return { turns, interrupted: true, error: text ? null : 'deliberation participant returned no response' }
      const turn = { role, round, text, messages: result.messages || [], usage: result.usage || null }
      turns.push(turn)
      peer = turn
      onEvent({ type: 'deliberation_turn', ...turn })
    }
  }

  const synthesis = await runSynthesis({ history: [{ role: 'user', content: synthesisPrompt(valid.brief, turns) }], signal })
  return {
    turns,
    result: resultText(synthesis.messages),
    usage: synthesis.usage || null,
    interrupted: !!synthesis.interrupted,
    error: synthesis.error || null,
  }
}
