import { buildProjectBoot } from 'picocode-core/boot.js'
import { createController } from 'picocode-core/controller.js'
import { createShellManager } from 'picocode-core/shells.js'
import { createWakeupManager } from 'picocode-core/wakeups.js'
import { createGitService } from 'picocode-core/git.js'
import { readConfig } from 'picocode-core/config.js'
import { defaultModel } from 'picocode-core/models.js'
import { loadModelRuntime } from './model-runtime.js'

export async function createDaemonSession({ cwd = process.cwd(), version, theme, detectedTheme, themePref } = {}) {
  const { models, providers, loadModels } = await loadModelRuntime()
  if (!providers.length) throw new Error('no model credentials found')
  const config = await readConfig()
  const notify = {}
  const shells = createShellManager({ onChange: () => notify.shells?.(), onExit: shell => notify.shellExit?.(shell) })
  const wakeups = createWakeupManager({ onChange: () => notify.wakeups?.(), onFire: wakeup => notify.wakeupFire?.(wakeup) })
  const git = createGitService({ onChange: () => notify.git?.() })
  const rebuild = cwd => buildProjectBoot(cwd, { onMcpChange: () => notify.mcp?.() })
  let boot
  try {
    boot = {
      ...await rebuild(cwd), version, theme, detectedTheme, themePref,
      models, providers, initialModel: models.find(m => m.name === config.defaultModel && m.available !== false) || defaultModel(models),
      researchModel: config.models?.researchWorker || null, shellModel: config.models?.shell || null,
      participantAModel: config.models?.participantA || null, participantBModel: config.models?.participantB || null,
      deliberationModel: config.models?.deliberation || config.models?.researchWorker || null,
      researchAgentLimit: Number.isInteger(config.research?.agentLimit) && config.research.agentLimit >= 1 && config.research.agentLimit <= 100 ? config.research.agentLimit : 10,
      initialEffort: ['low', 'medium', 'high', 'max'].includes(config.defaultEffort) ? config.defaultEffort : null, speedDefaults: config.speedDefaults,
      autoCompact: config.autoCompact !== false, clouds: config.animation?.clouds === true,
      compactToolHistory: config.display?.compactToolHistory === true, gitFooter: config.display?.gitStatus !== false,
      wideSidebar: config.display?.wideSidebar !== false, refs: {}, shells, wakeups, git, rebuild,
      refreshModels: () => loadModels({ force: true }),
      setMcpNotify: fn => { notify.mcp = fn }, setGitNotify: fn => { notify.git = fn },
      setShellsNotify: fn => { notify.shells = fn }, setShellsExit: fn => { notify.shellExit = fn },
      setWakeupsNotify: fn => { notify.wakeups = fn }, setWakeupsFire: fn => { notify.wakeupFire = fn },
    }
    git.retarget(boot.root)
    git.setEnabled(boot.gitFooter)
    const controller = createController({ boot })
    boot.mcp.connectAll()
    return { controller, dispose: () => { git.dispose(); wakeups.cancelAll(); shells.killAll() } }
  } catch (error) { git.dispose(); shells.killAll(); boot?.mcp.terminateAll(); throw error }
}
