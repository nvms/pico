import { readFileSync } from 'node:fs'
import { mount } from '@trendr/core'
import { parseArgs, USAGE } from './cli-args.js'
import { discoverKeys, applyKeys, keyHint } from './core/keys.js'
import { defaultModel } from './core/models.js'
import { loadCatalog, extractModels } from './core/catalog.js'
import { readConfig } from './core/config.js'
import { buildProjectBoot } from './core/boot.js'
import { createShellManager } from './core/shells.js'
import { App } from './ui/app.jsx'
import { DEFAULT_ACCENT } from './ui/theme.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))

let cli
try {
  cli = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`pico: ${err.message}`)
  console.error(USAGE)
  process.exit(1)
}
if (cli.mode === 'help') {
  console.log(USAGE)
  process.exit(0)
}
if (cli.mode === 'version') {
  console.log(pkg.version)
  process.exit(0)
}
if (cli.mode === 'headless') {
  const { runHeadless } = await import('./headless.js')
  process.exit(await runHeadless(cli))
}

const keys = discoverKeys()
const providers = applyKeys(keys)
const models = extractModels(await loadCatalog(), ['google', 'anthropic', 'openai', 'xai']).map((m) => ({
  ...m,
  available: providers.includes(m.provider),
  keyHint: keyHint(m.provider),
}))

if (providers.length === 0) {
  console.error('pico: no API keys found in the environment.')
  console.error('set one of: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY')
  process.exit(1)
}

let mcpNotify = () => {}
let shellsNotify = () => {}
let shellsExit = () => {}
const shells = createShellManager({
  onChange: () => shellsNotify(),
  onExit: (shell) => shellsExit(shell),
})
process.on('exit', () => shells.killAll())

const bootProject = (cwd) => buildProjectBoot(cwd, { onMcpChange: () => mcpNotify() })

const config = await readConfig()
const configuredDefault = config.defaultModel && models.find((m) => m.name === config.defaultModel)

const theme = { accent: DEFAULT_ACCENT }

const boot = {
  ...(await bootProject(process.cwd())),
  theme,
  version: pkg.version,
  models,
  providers,
  initialModel: configuredDefault || defaultModel(models),
  initialEffort: ['low', 'medium', 'high', 'max'].includes(config.defaultEffort) ? config.defaultEffort : null,
  refs: {},
  shells,
  setMcpNotify: (fn) => { mcpNotify = fn },
  setShellsNotify: (fn) => { shellsNotify = fn },
  setShellsExit: (fn) => { shellsExit = fn },
  rebuild: bootProject,
}

const app = mount(() => <App boot={boot} />, { title: `pico · ${boot.root.split('/').pop()}`, theme })
boot.setTheme = app.setTheme
boot.mcp.connectAll()
