import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const TTL = 24 * 60 * 60 * 1000

function cacheFile() {
  return join(picoHome(), 'openrouter-models-cache.json')
}

// batch twins are only served by the async batch api and 404 on chat completions
const chatUsable = (m) => m.supported_parameters?.includes('tools') && !m.id.endsWith(':batch')

// openrouter prices per token as strings, and negative for routers whose
// price depends on the model they pick
function perMillion(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e12) / 1e6
}

function price(pricing) {
  const input = perMillion(pricing?.prompt)
  const output = perMillion(pricing?.completion)
  return input == null || output == null ? null : { in: input, out: output }
}

export function slimOpenRouterModels(entries) {
  return entries.filter(chatUsable).map((m) => ({
    id: m.id,
    name: m.name,
    created: m.created || 0,
    pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion },
    context_length: m.context_length || null,
    reasoning: m.supported_parameters.includes('reasoning'),
    input_modalities: m.architecture?.input_modalities || ['text'],
  }))
}

export function mapOpenRouterModels(entries) {
  return [...entries]
    .sort((a, b) => b.created - a.created)
    .map((m) => ({
      name: `openrouter/${m.id}`,
      provider: 'openrouter',
      desc: m.name || m.id,
      price: price(m.pricing),
      effort: m.reasoning,
      vision: m.input_modalities.includes('image'),
      context: m.context_length,
    }))
}

async function readCache() {
  try {
    return JSON.parse(await readFile(cacheFile(), 'utf-8'))
  } catch {
    return null
  }
}

async function fetchModels(fetcher) {
  const response = await fetcher(MODELS_URL)
  if (!response.ok) throw new Error(`openrouter models fetch failed: ${response.status}`)
  const models = slimOpenRouterModels((await response.json()).data || [])
  if (models.length === 0) throw new Error('empty openrouter model list')
  ensureDir(picoHome())
  await writeFile(cacheFile(), JSON.stringify({ at: Date.now(), models }))
  return models
}

export async function loadOpenRouterModels({ force = false, fetcher = fetch } = {}) {
  if (force) return mapOpenRouterModels(await fetchModels(fetcher))
  const cached = await readCache()
  if (cached && Date.now() - cached.at < TTL) return mapOpenRouterModels(cached.models)
  try {
    return mapOpenRouterModels(await fetchModels(fetcher))
  } catch {
    return mapOpenRouterModels(cached?.models || [])
  }
}
