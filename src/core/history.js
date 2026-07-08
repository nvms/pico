import { appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, projectDir, projectHistoryFile, ensureDir } from './paths.js'

const MAX_PROMPTS_PER_SCOPE = 1000

export async function appendPrompt(root, text) {
  ensureDir(projectDir(root))
  await appendFile(projectHistoryFile(root), JSON.stringify({ text, at: Date.now() }) + '\n')
}

function parsePromptLines(text) {
  return text
    .split('\n')
    .map((line) => {
      try {
        return line.trim() ? JSON.parse(line) : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function readPrompts(file, scope) {
  try {
    const entries = parsePromptLines(await readFile(file, 'utf-8'))
    return entries
      .filter((e) => typeof e.text === 'string' && e.text.trim())
      .slice(-MAX_PROMPTS_PER_SCOPE)
      .map((e) => ({ text: e.text, at: e.at || 0, scope }))
  } catch {
    return []
  }
}

export function loadProjectPrompts(root) {
  return readPrompts(projectHistoryFile(root), 'project')
}

export async function loadGlobalPrompts() {
  const projectsDir = join(picoHome(), 'projects')
  let projects = []
  try {
    projects = await readdir(projectsDir)
  } catch {}
  const nested = await Promise.all(
    projects.map((p) => readPrompts(join(projectsDir, p, 'history.jsonl'), 'everywhere')),
  )
  return nested.flat().sort((a, b) => b.at - a.at).slice(0, MAX_PROMPTS_PER_SCOPE)
}
