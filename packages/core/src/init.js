export const INIT_PROMPT = `Initialize or improve this repository's AGENTS.md guidance for future pico sessions.

Do this discovery yourself as the main agent. Do not call agent_plan, agent_start, agent_list, agent_collect, or delegate any part of this task to another agent.

Inspect the repository directly and then create or update its AGENTS.md files. Read enough of the actual project to understand its structure and workflows, including the relevant manifests, documentation, configuration, source layout, tests, scripts, and existing instruction files. Use targeted searches and representative files rather than exhaustively reading every file. If an AGENTS.md already exists, preserve useful human-authored guidance and improve it conservatively instead of replacing it blindly. Check CLAUDE.md files for useful repository guidance when relevant, but write canonical guidance to AGENTS.md.

Write instructions that help an agent work correctly in this specific repository. Capture only durable, non-obvious information such as:

- the project's purpose and high-level architecture
- important module boundaries and data flow
- authoritative build, test, lint, typecheck, and development commands
- repository-specific conventions and constraints
- where and how to add common kinds of changes
- validation expectations and operational gotchas

Keep the root AGENTS.md concise: aim for 100-200 lines or roughly 1,000-2,000 tokens, and treat about 3,000 tokens as a hard default ceiling. This is guidance, not generated documentation. Prefer terse sections and bullets. Omit generic programming advice, exhaustive directory listings, dependency inventories, and facts that are obvious from standard files or easy to rediscover. Do not speculate or document claims you have not verified.

If materially different subtrees need scoped instructions, put focused AGENTS.md files in those subtrees instead of expanding the root file. Create them only when they reduce total context and contain genuinely local guidance; do not fragment the instructions unnecessarily or duplicate the root file. Remember that a nested file augments the root instructions for work in that subtree.

Make the edits in this invocation, then briefly summarize which AGENTS.md files you created or changed and what you verified.`

export function initPrompt(args = '') {
  const request = args.trim()
  return request ? `${INIT_PROMPT}\n\nAdditional request from the user:\n${request}` : INIT_PROMPT
}
