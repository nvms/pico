import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

// the backend hides models from clients below a version floor, so send a
// version comfortably above it
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=2.0.0'
const TTL = 24 * 60 * 60 * 1000

function cacheFile() {
  return join(picoHome(), 'codex-models-cache.json')
}

export function mapCodexModels(entries) {
  return entries.map((m) => ({
    name: `codex/${m.slug}`,
    provider: 'codex',
    desc: `${m.description || m.label || m.slug} · via ChatGPT plan`,
    price: null,
    effort: true,
    context: m.context_window || null,
  }))
}

export async function loadCodexModels(credentials) {
  let cached = null
  try {
    cached = JSON.parse(await readFile(cacheFile(), 'utf-8'))
  } catch {}
  if (cached && Date.now() - cached.at < TTL) return mapCodexModels(cached.models)
  if (!credentials) return mapCodexModels(cached?.models || [])

  try {
    const response = await fetch(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        ...credentials.headers,
        originator: 'codex_cli_rs',
      },
    })
    if (!response.ok) throw new Error(String(response.status))
    const data = await response.json()
    const models = (data.models || []).map((m) => ({
      slug: m.slug,
      description: m.description,
      label: m.label || m.display_name,
      context_window: m.context_window || m.max_context_window || null,
    }))
    if (models.length === 0) throw new Error('empty model list')
    ensureDir(picoHome())
    await writeFile(cacheFile(), JSON.stringify({ at: Date.now(), models }))
    return mapCodexModels(models)
  } catch {
    return mapCodexModels(cached?.models || [])
  }
}
