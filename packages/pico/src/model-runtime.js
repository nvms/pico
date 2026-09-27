import { discoverKeys, applyKeys, keyHint } from 'picocode-core/keys.js'
import { loadCatalog, extractModels, adhocModel } from 'picocode-core/catalog.js'
import { loadCodexModels } from 'picocode-core/codex-models.js'
import { loadOpenRouterModels } from 'picocode-core/openrouter-models.js'
import { openaiConnected, openaiCredentials } from 'picocode-core/openai-auth.js'
import { defaultModel } from 'picocode-core/models.js'
import { fuzzyScore } from 'picocode-core/fuzzy.js'

const CATALOG_PROVIDERS = ['google', 'anthropic', 'openai', 'xai']

function codexContext(catalogData, model) {
  const entry = catalogData.openai?.models?.[model.name.split('/')[1]]
  return model.context ?? entry?.limit?.input ?? entry?.limit?.context ?? null
}

async function buildModels({ providers, force }) {
  const has = (provider) => providers.includes(provider)
  const codexCredentials = has('codex') ? await openaiCredentials().catch(() => null) : null
  const [catalogData, codex, openrouter] = await Promise.all([
    loadCatalog({ force }),
    loadCodexModels(codexCredentials, { force }),
    has('openrouter') ? loadOpenRouterModels({ force }) : [],
  ])
  return [
    ...extractModels(catalogData, CATALOG_PROVIDERS).map((model) => ({
      ...model,
      available: has(model.provider),
      keyHint: keyHint(model.provider),
    })),
    ...codex.map((model) => ({
      ...model,
      context: codexContext(catalogData, model),
      available: has('codex'),
      keyHint: '/connect',
    })),
    ...openrouter.map((model) => ({ ...model, available: true, keyHint: keyHint('openrouter') })),
  ]
}

export async function loadModelRuntime() {
  const chatgpt = await openaiConnected()
  const providers = [...applyKeys(discoverKeys()), ...(chatgpt ? ['codex'] : [])]
  const codexCredentials = chatgpt ? await openaiCredentials().catch(() => null) : null
  const loadModels = ({ force = false } = {}) => buildModels({ providers, force })
  return { providers, models: await loadModels(), codexCredentials, loadModels }
}

export function resolveModel(models, providers, name) {
  if (!name) return null
  const exact = models.find((model) => model.name === name)
  if (exact) return exact
  if (name.includes('/')) return adhocModel(name, providers)
  const available = models.filter((model) => model.available !== false)
  return available
      .map((model) => [fuzzyScore(name, model.name), model])
      .filter(([score]) => score >= 0)
      .sort((a, b) => b[0] - a[0])[0]?.[1]
    || null
}

export function selectModel({ models, providers, requested, configured }) {
  return resolveModel(models, providers, requested)
    || (configured && models.find((model) => model.name === configured && model.available))
    || defaultModel(models)
}
