import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ensureDaemon } from 'picocode-core/daemon-transport.js'
import { createRemoteController } from 'picocode-core/remote-controller.js'
import { mount } from '@trendr/core'
import { parseArgs, USAGE } from './cli-args.js'
import { loadModelRuntime } from 'picocode-core/model-runtime.js'
import { readConfig } from 'picocode-core/config.js'
import { detectTerminalTheme } from 'picocode-core/terminal-theme.js'
import { App } from './ui/app.jsx'
import { DEFAULT_ACCENT, MUTED, setPalette, setTerminalBackground, paletteList } from './ui/theme.js'

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
if (cli.mode === 'update') {
  const { isDevInstall, runUpdate, fetchLatestVersion, newerVersion } = await import('picocode-core/update.js')
  if (isDevInstall(import.meta.url)) {
    console.error('this pico runs from a source checkout; update it with git, not npm')
    process.exit(1)
  }
  const latest = await fetchLatestVersion().catch(() => null)
  if (latest && !newerVersion(pkg.version, latest)) {
    console.log(`pico v${pkg.version} is already the latest`)
    process.exit(0)
  }
  console.error(`updating picocode ${latest ? `to v${latest} ` : ''}via npm...`)
  const result = await runUpdate()
  if (result.ok) {
    console.log(`updated${latest ? ` to v${latest}` : ''}`)
    process.exit(0)
  }
  console.error(`update failed:\n${result.output}`)
  process.exit(1)
}
if (cli.mode === 'connect') {
  const { signInFor } = await import('picocode-core/sign-in/index.js')
  const signIn = signInFor(cli.connectProvider)
  try {
    const flow = await signIn.start()
    const page = await flow.page
    console.error(`sign in to ${signIn.label} on this page:\n${page.url}${page.code ? `\ncode: ${page.code}` : ''}`)
    if (flow.input) {
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const asked = rl.question(flow.input === 'code' ? 'code from the page: ' : 'if the page ended on an address that did not load, paste it here: ')
      flow.done.then(() => rl.close(), () => rl.close())
      const text = await asked.catch(() => null)
      if (text?.trim()) await flow.finish(text)
    }
    const { identity } = await flow.done
    console.log(`signed in to ${signIn.label}${identity ? ` as ${identity}` : ''}`)
    process.exit(0)
  } catch (err) {
    console.error(`sign-in failed: ${err.message}`)
    process.exit(1)
  }
}
if (cli.mode === 'acp') {
  // stdout carries only ACP messages; whatever pico would print goes to stderr
  for (const level of ['log', 'info', 'warn', 'debug']) console[level] = (...args) => console.error(...args)
  const { serveAgent } = await import('picocode-core/acp/connect.js')
  const { createPicoAgent } = await import('picocode-core/acp/pico-agent.js')
  await serveAgent((client, control) => createPicoAgent(client, control, { version: pkg.version }))
  process.exit(0)
}
if (cli.mode === 'headless') {
  const { runHeadless } = await import('./headless.js')
  process.exit(await runHeadless(cli))
}
if (cli.mode === 'shell') {
  const { runShell } = await import('./shell.js')
  process.exit(await runShell(cli))
}

const { providers } = await loadModelRuntime()

if (providers.length === 0) {
  console.error('pico: no credentials found.')
  console.error('set one of: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY')
  console.error('or sign in: pico --connect openai | pico --connect xai')
  process.exit(1)
}

const config = await readConfig()

const { theme: detectedTheme, background: terminalBackground } = await detectTerminalTheme()
const themeOverride = paletteList().some((p) => p.key === config.theme) ? config.theme : null
setTerminalBackground(terminalBackground)
setPalette(themeOverride || detectedTheme)
const theme = { accent: DEFAULT_ACCENT, muted: MUTED }

const connection = await ensureDaemon({ entry: fileURLToPath(new URL('./daemon.js', import.meta.url)) })
const controller = await createRemoteController(connection, {
  options: { cwd: process.cwd(), version: pkg.version, theme, detectedTheme, themePref: themeOverride || 'auto' },
  localBoot: { refs: {} },
})
const boot = controller.boot
if (cli.speed) await controller.speedCommand(cli.speed)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  connection.close()
  process.exit(0)
})
process.on('exit', () => connection.close())
const app = mount(() => <App boot={boot} controller={controller} />, { title: `pico  ${boot.root.split('/').pop()}`, theme })
boot.setTheme = app.setTheme
