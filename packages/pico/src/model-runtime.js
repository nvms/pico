import { discoverKeys, applyKeys } from 'picocode-core/keys.js'
import { loadCatalog, extractModels, adhocModel } from 'picocode-core/catalog.js'
import { loadCodexModels } from 'picocode-core/codex-models.js'
import { openaiConnected, openaiCredentials } from 'picocode-core/openai-auth.js'
import { defaultModel } from 'picocode-core/models.js'
import { fuzzyScore } from 'picocode-core/fuzzy.js'

export async function loadModelRuntime() {
  const chatgpt = await openaiConnected()
  const providers = [...applyKeys(discoverKeys()), ...(chatgpt ? ['codex'] : [])]
  const catalogData = await loadCatalog()
  const codexCredentials = chatgpt ? await openaiCredentials().catch(() => null) : null
  const models = [
    ...extractModels(catalogData, ['google', 'anthropic', 'openai', 'xai']).map((model) => ({
      ...model,
      available: providers.includes(model.provider),
    })),
    ...(await loadCodexModels(codexCredentials)).map((model) => ({ ...model, available: chatgpt })),
  ]
  return { providers, models, codexCredentials }
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
