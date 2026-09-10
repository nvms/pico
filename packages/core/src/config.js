import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

function configFile() {
  return join(picoHome(), 'config.json')
}

export async function readConfig() {
  try {
    const config = JSON.parse(await readFile(configFile(), 'utf-8'))
    if (config.models) {
      if (!Object.hasOwn(config.models, 'participantA')) config.models.participantA = config.models.proposer ?? null
      if (!Object.hasOwn(config.models, 'participantB')) config.models.participantB = config.models.reviewer ?? null
    }
    return config
  } catch {
    return {}
  }
}

function mergeConfig(base, patch) {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value)
      : value
  }
  return result
}

export async function writeConfig(patch) {
  const config = mergeConfig(await readConfig(), patch)
  ensureDir(picoHome())
  await writeFile(configFile(), JSON.stringify(config, null, 2) + '\n')
  return config
}
