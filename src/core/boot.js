import { homedir } from 'node:os'
import { findProjectRoot } from './paths.js'
import { loadStartupContext, createContextTracker } from './context.js'
import { createSkillIndex } from './skills.js'
import { createCommandIndex } from './commands.js'
import { createMcpRuntime } from './mcp.js'
import { createMemory } from './memory.js'

export async function buildProjectBoot(cwd, { onMcpChange = () => {} } = {}) {
  const home = homedir()
  const root = findProjectRoot(cwd)
  const startupContext = loadStartupContext(cwd)
  const tracker = createContextTracker({
    stopDir: startupContext.stopDir,
    loaded: new Set(startupContext.files.map((f) => f.path)),
  })
  return {
    cwd,
    root,
    displayCwd: cwd.startsWith(home) ? cwd.replace(home, '~') : cwd,
    startupContext,
    tracker,
    skills: await createSkillIndex(root),
    commands: await createCommandIndex(root),
    mcp: await createMcpRuntime({ root, onChange: onMcpChange }),
    memory: createMemory(root),
  }
}
