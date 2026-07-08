import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

function configFile() {
  return join(picoHome(), 'config.json')
}

export async function readConfig() {
  try {
    return JSON.parse(await readFile(configFile(), 'utf-8'))
  } catch {
    return {}
  }
}

export async function writeConfig(patch) {
  const config = { ...(await readConfig()), ...patch }
  ensureDir(picoHome())
  await writeFile(configFile(), JSON.stringify(config, null, 2) + '\n')
  return config
}
