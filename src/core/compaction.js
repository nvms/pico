export function compactionPrompt(customInstructions = '') {
  let prompt = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. The summary must let work continue seamlessly without the original messages.

Before writing the summary, draft your analysis inside <analysis> tags (it will be discarded): chronologically re-read the conversation and note the user's explicit requests and intents, your approach, key decisions, file names and code, errors and how they were fixed, and any user feedback or corrections, especially where the user told you to do something differently.

Then produce a <summary> block with exactly these sections:

1. Primary Request and Intent: all of the user's explicit requests, in detail
2. Key Technical Concepts: technologies, patterns, and decisions in play
3. Files and Code Sections: files examined, modified, or created; why each matters; important snippets verbatim
4. Errors and Fixes: every error hit and how it was fixed, including user feedback about it
5. All User Messages: every non-tool-result user message, so intent and its changes survive
6. Pending Tasks: anything explicitly requested and not yet done
7. Current Work: precisely what was in progress just now, with file names and direct quotes
8. Next Step: only if directly in line with the most recent explicit request; include verbatim quotes showing exactly where work left off, or state that there is none

This summarization request is not part of the conversation: do not list it as a user message, count it as a task, or let it appear as the current work or next step. Summarize only what came before it.

Respond with plain text only: one <analysis> block followed by one <summary> block.`

  if (customInstructions.trim()) {
    prompt += `\n\nAdditional instructions:\n${customInstructions.trim()}`
  }
  return prompt
}

export function formatCompactSummary(raw) {
  let formatted = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) formatted = match[1]
  return formatted.replace(/\n\n+/g, '\n\n').trim()
}

export function continuationMessage(summary, { sessionFile, recentKept } = {}) {
  let text = `[system notification] The earlier portion of this conversation was compacted to free context. Summary of what came before:\n\n${summary}`
  if (sessionFile) {
    text += `\n\nThe complete pre-compaction history is preserved at ${sessionFile} (jsonl, one event per line). If you need exact details from before compaction, such as code you generated or precise error text, read that file with your tools.`
  }
  if (recentKept) {
    text += `\n\nThe most recent messages follow verbatim.`
  }
  text += `\n\nContinue exactly where things left off. Do not recap, acknowledge this summary, or re-ask settled questions.`
  return text
}
