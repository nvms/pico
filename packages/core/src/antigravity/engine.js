// Antigravity as pico's sessions run it: the ACP engine (../acp/engine.js)
// over Google's own `agy acp`, through the Antigravity adapter.

import { basename, dirname, isAbsolute, relative } from 'node:path'
import { createAcpEngine, HOST_NOTE } from '../acp/engine.js'
import { connectAntigravity } from './adapter.js'
import { ANTIGRAVITY_PROVIDER } from './models.js'

// agy reads the AGENTS.md and GEMINI.md files of the project it works in
// itself; any other instructions pico would give its own models (a global
// AGENTS.md, say) are passed along
export function systemPrompt({ contextFiles = [], memoryIndexText = '', cwd } = {}) {
  const own = (file) => {
    if (!['AGENTS.md', 'GEMINI.md'].includes(basename(file.path)) || !cwd) return false
    const rel = relative(dirname(file.path), cwd)
    return !rel.startsWith('..') && !isAbsolute(rel)
  }
  const files = contextFiles.filter((file) => !own(file) && file.content?.trim())
  const parts = [HOST_NOTE]
  if (memoryIndexText) parts.push(memoryIndexText.replace(/\bthe (remember|recall) tool\b/g, 'the pico server\'s $1 tool'))
  if (files.length) parts.push(`Project instructions:\n\n${files.map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`).join('\n\n')}`)
  return parts.join('\n\n')
}

export function createAntigravityEngine({ connect = connectAntigravity, ...options } = {}) {
  return createAcpEngine({ provider: ANTIGRAVITY_PROVIDER, label: 'Antigravity', connect, systemPrompt, ...options })
}
