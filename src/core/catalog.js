import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'
import snapshot from './catalog-snapshot.json' with { type: 'json' }

const CATALOG_URL = 'https://models.dev/api.json'
const SUPPORTED = ['google', 'anthropic', 'openai', 'xai']
const TTL = 24 * 60 * 60 * 1000

function cacheFile() {
  return join(picoHome(), 'models-cache.json')
}

function subset(data) {
  const out = {}
  for (const provider of SUPPORTED) {
    if (data[provider]?.models) out[provider] = { models: data[provider].models }
  }
  return out
}

async function readCache() {
  try {
    return JSON.parse(await readFile(cacheFile(), 'utf-8'))
  } catch {
    return null
  }
}

export async function refreshCatalog({ fetcher = fetch } = {}) {
  const response = await fetcher(CATALOG_URL)
  if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`)
  const providers = subset(await response.json())
  ensureDir(picoHome())
  await writeFile(cacheFile(), JSON.stringify({ at: Date.now(), providers }))
  return providers
}

export async function loadCatalog({ fetcher = fetch } = {}) {
  const cached = await readCache()
  if (cached && Date.now() - cached.at < TTL) return cached.providers
  refreshCatalog({ fetcher }).catch(() => {})
  return cached?.providers || snapshot
}

const textModel = (m) =>
  m.tool_call === true &&
  (!m.modalities || (m.modalities.input?.includes('text') && m.modalities.output?.includes('text')))

const datedDuplicate = (id) => /-\d{8}$/.test(id)

export function extractModels(providers, providerIds) {
  const order = SUPPORTED.filter((p) => providerIds.includes(p))
  const models = []
  for (const provider of order) {
    const entries = Object.entries(providers[provider]?.models || {})
      .filter(([id, m]) => textModel(m) && !datedDuplicate(id))
      .sort((a, b) => String(b[1].release_date || '').localeCompare(String(a[1].release_date || '')))
    for (const [id, m] of entries) {
      models.push({
        name: `${provider}/${id}`,
        provider,
        desc: m.description || m.name || id,
        price: m.cost && m.cost.input != null ? { in: m.cost.input, out: m.cost.output } : null,
        effort: !!m.reasoning,
        context: m.limit?.context || null,
      })
    }
  }
  return models
}

export function adhocModel(name, providerIds) {
  const match = name.match(/^([a-z0-9-]+)\/(.+)$/)
  if (!match || !providerIds.includes(match[1])) return null
  return {
    name,
    provider: match[1],
    desc: 'not in catalog',
    price: null,
    effort: false,
    context: null,
  }
}
