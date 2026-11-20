// A pico session on this machine, everything it runs with put together:
// the project's boot, the models, the shells, wake-ups and git it uses,
// and pico's settings. The terminal app's daemon and the ACP server open
// sessions the same way. `extra` adds what one host keeps on the boot.

import { buildProjectBoot } from './boot.js'
import { createController } from './controller.js'
import { createShellManager } from './shells.js'
import { createWakeupManager } from './wakeups.js'
import { createGitService } from './git.js'
import { readConfig } from './config.js'
import { defaultModel } from './models.js'
import { loadModelRuntime } from './model-runtime.js'

// `mcpServers` are the session's own MCP servers (name to command)
export async function createLocalSession({ cwd = process.cwd(), runtime = null, mcpServers = {}, extra = {}, gitFooter = true } = {}) {
  const { models, providers, loadModels } = runtime ?? await loadModelRuntime()
  if (!providers.length) throw new Error('no model credentials found')
  const config = await readConfig()
  const notify = {}
  const shells = createShellManager({ onChange: () => notify.shells?.(), onExit: shell => notify.shellExit?.(shell) })
  const wakeups = createWakeupManager({ onChange: () => notify.wakeups?.(), onFire: wakeup => notify.wakeupFire?.(wakeup) })
  const git = createGitService({ onChange: () => notify.git?.() })
  const rebuild = cwd => buildProjectBoot(cwd, { onMcpChange: () => notify.mcp?.(), mcpServers })
  let boot
  try {
    boot = {
      ...await rebuild(cwd),
      models, providers, initialModel: models.find(m => m.name === config.defaultModel && m.available !== false) || defaultModel(models),
      researchModel: config.models?.researchWorker || null, shellModel: config.models?.shell || null,
      participantAModel: config.models?.participantA || null, participantBModel: config.models?.participantB || null,
      deliberationModel: config.models?.deliberation || config.models?.researchWorker || null,
      prompts: config.prompts ?? null,
      initialEffort: ['low', 'medium', 'high', 'max'].includes(config.defaultEffort) ? config.defaultEffort : null, speedDefaults: config.speedDefaults,
      autoCompact: config.autoCompact !== false,
      refs: {}, shells, wakeups, git, rebuild,
      refreshModels: () => loadModels({ force: true }),
      setMcpNotify: fn => { notify.mcp = fn }, setGitNotify: fn => { notify.git = fn },
      setShellsNotify: fn => { notify.shells = fn }, setShellsExit: fn => { notify.shellExit = fn },
      setWakeupsNotify: fn => { notify.wakeups = fn }, setWakeupsFire: fn => { notify.wakeupFire = fn },
      ...extra,
    }
    git.retarget(boot.root)
    git.setEnabled(gitFooter)
    const controller = createController({ boot })
    boot.mcp.connectAll()
    return { controller, boot, config, dispose: () => { git.dispose(); wakeups.cancelAll(); shells.killAll() } }
  } catch (error) { git.dispose(); shells.killAll(); boot?.mcp.terminateAll(); throw error }
}
