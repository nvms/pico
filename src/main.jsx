import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { mount } from '@trendr/core'
import { discoverKeys, applyKeys } from './core/keys.js'
import { availableModels, defaultModel } from './core/models.js'
import { readConfig } from './core/config.js'
import { findProjectRoot } from './core/paths.js'
import { loadStartupContext, createContextTracker } from './core/context.js'
import { createSkillIndex } from './core/skills.js'
import { createCommandIndex } from './core/commands.js'
import { createMcpRuntime } from './core/mcp.js'
import { App } from './ui/app.jsx'
import { DEFAULT_ACCENT } from './ui/theme.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

const keys = discoverKeys()
const providers = applyKeys(keys)
const models = availableModels(providers)

if (models.length === 0) {
  console.error('pico: no API keys found in the environment.')
  console.error('set one of: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY')
  process.exit(1)
}

const cwd = process.cwd()
const root = findProjectRoot(cwd)
const home = homedir()
const displayCwd = cwd.startsWith(home) ? cwd.replace(home, '~') : cwd

const startupContext = loadStartupContext(cwd)
const tracker = createContextTracker({
  stopDir: startupContext.stopDir,
  loaded: new Set(startupContext.files.map((f) => f.path)),
})

const skills = await createSkillIndex(root)
const commands = await createCommandIndex(root)

let mcpNotify = () => {}
const mcp = await createMcpRuntime({ root, onChange: () => mcpNotify() })

const config = await readConfig()
const configuredDefault = config.defaultModel && models.find((m) => m.name === config.defaultModel)

const theme = { accent: DEFAULT_ACCENT }

const boot = {
  cwd,
  root,
  displayCwd,
  theme,
  version: pkg.version,
  models,
  commands,
  initialModel: configuredDefault || defaultModel(providers),
  initialEffort: ['low', 'medium', 'high', 'max'].includes(config.defaultEffort) ? config.defaultEffort : null,
  skills,
  mcp,
  tracker,
  startupContext,
  refs: {},
  setMcpNotify: (fn) => { mcpNotify = fn },
}

mount(() => <App boot={boot} />, { title: 'pico', theme })
mcp.connectAll()
