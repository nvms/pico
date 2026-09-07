import { readFile } from 'node:fs/promises'
import { createContextTracker } from './context.js'
import { buildSystemPrompt } from './system-prompt.js'
import { memoryIndex } from './memory.js'

export async function createAgentContext(boot, { userTools = [], isolated = false, instructions = '' } = {}) {
  const files = [...boot.startupContext.files]
  if (isolated) {
    const known = new Set(files.map((file) => file.path))
    for (const path of boot.tracker.loaded) {
      if (known.has(path)) continue
      const content = await readFile(path, 'utf8').catch(() => null)
      if (content !== null) files.push({ path, content })
    }
  }
  const tracker = isolated
    ? createContextTracker({ stopDir: boot.startupContext.stopDir, loaded: new Set(files.map((file) => file.path)) })
    : boot.tracker
  const system = buildSystemPrompt({
    cwd: boot.cwd,
    contextFiles: files,
    skills: boot.skills.list(),
    memoryIndexText: memoryIndex(await boot.memory.list().catch(() => []), boot.root),
  })
  return {
    system: instructions ? `${system}\n\n${instructions}` : system,
    tools: {
      cwd: boot.cwd,
      env: boot.env,
      tracker,
      skills: boot.skills,
      memory: boot.memory,
      shells: boot.shells,
      hostTools: (boot.hostTools ?? []).filter((tool) => !isolated || !tool.name.startsWith('browser_')),
      userTools,
      mcpTools: boot.mcp.tools(),
    },
  }
}
