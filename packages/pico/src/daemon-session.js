import { readConfig } from 'picocode-core/config.js'
import { createLocalSession } from 'picocode-core/local-session.js'

export async function createDaemonSession({ cwd = process.cwd(), version, theme, detectedTheme, themePref } = {}) {
  const config = await readConfig()
  const gitFooter = config.display?.gitStatus !== false
  const { controller, dispose } = await createLocalSession({
    cwd,
    gitFooter,
    extra: {
      version, theme, detectedTheme, themePref,
      clouds: config.animation?.clouds === true,
      compactToolHistory: config.display?.compactToolHistory === true, gitFooter,
      wideSidebar: config.display?.wideSidebar !== false,
    },
  })
  return { controller, dispose }
}
