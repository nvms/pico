import { readFileSync } from 'node:fs'
import { mount } from '@trendr/core'
import { parseArgs, USAGE } from './cli-args.js'
import { discoverKeys, applyKeys, keyHint } from './core/keys.js'
import { defaultModel } from './core/models.js'
import { loadCatalog, extractModels } from './core/catalog.js'
import { loadCodexModels } from './core/codex-models.js'
import { openaiConnected, openaiCredentials } from './core/openai-auth.js'
import { readConfig } from './core/config.js'
import { detectTerminalTheme } from './core/terminal-theme.js'
import { buildProjectBoot } from './core/boot.js'
import { createShellManager } from './core/shells.js'
import { createWakeupManager } from './core/wakeups.js'
import { App } from './ui/app.jsx'
import { DEFAULT_ACCENT, setPalette } from './ui/theme.js'

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
if (cli.mode === 'connect') {
  const { connectOpenAI } = await import('./core/openai-auth.js')
  try {
    console.error('opening your browser for ChatGPT sign-in...')
    const { email } = await connectOpenAI({ onUrl: (url) => console.error(`if the browser did not open, visit:\n${url}`) })
    console.log(`connected as ${email || 'your ChatGPT account'}`)
    process.exit(0)
  } catch (err) {
    console.error(`connect failed: ${err.message}`)
    process.exit(1)
  }
}
if (cli.mode === 'headless') {
  const { runHeadless } = await import('./headless.js')
  process.exit(await runHeadless(cli))
}

const keys = discoverKeys()
const chatgpt = await openaiConnected()
const providers = [...applyKeys(keys), ...(chatgpt ? ['codex'] : [])]
const catalogData = await loadCatalog()
const codexCreds = chatgpt ? await openaiCredentials().catch(() => null) : null
const models = [
  ...extractModels(catalogData, ['google', 'anthropic', 'openai', 'xai']).map((m) => ({
    ...m,
    available: providers.includes(m.provider),
    keyHint: keyHint(m.provider),
  })),
  ...(await loadCodexModels(codexCreds)).map((m) => ({
    ...m,
    context: m.context
      ?? catalogData.openai?.models?.[m.name.split('/')[1]]?.limit?.input
      ?? catalogData.openai?.models?.[m.name.split('/')[1]]?.limit?.context
      ?? null,
    available: chatgpt,
    keyHint: '/connect',
  })),
]

if (providers.length === 0) {
  console.error('pico: no credentials found.')
  console.error('set one of: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY')
  console.error('or sign in with a ChatGPT plan: pico --connect')
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

let wakeupsNotify = () => {}
let wakeupsFire = () => {}
const wakeups = createWakeupManager({
  onChange: () => wakeupsNotify(),
  onFire: (wakeup) => wakeupsFire(wakeup),
})

const bootProject = (cwd) => buildProjectBoot(cwd, { onMcpChange: () => mcpNotify() })

const config = await readConfig()
const configuredDefault = config.defaultModel && models.find((m) => m.name === config.defaultModel)

setPalette(['light', 'dark'].includes(config.theme) ? config.theme : await detectTerminalTheme())
const theme = { accent: DEFAULT_ACCENT }

const boot = {
  ...(await bootProject(process.cwd())),
  theme,
  version: pkg.version,
  models,
  providers,
  initialModel: configuredDefault || defaultModel(models),
  initialEffort: ['low', 'medium', 'high', 'max'].includes(config.defaultEffort) ? config.defaultEffort : null,
  autoCompact: config.autoCompact !== false,
  refs: {},
  shells,
  wakeups,
  setMcpNotify: (fn) => { mcpNotify = fn },
  setShellsNotify: (fn) => { shellsNotify = fn },
  setShellsExit: (fn) => { shellsExit = fn },
  setWakeupsNotify: (fn) => { wakeupsNotify = fn },
  setWakeupsFire: (fn) => { wakeupsFire = fn },
  rebuild: bootProject,
}

const app = mount(() => <App boot={boot} />, { title: `pico · ${boot.root.split('/').pop()}`, theme })
boot.setTheme = app.setTheme
boot.mcp.connectAll()
