// Every model this machine can run, and what each runs with: API keys,
// the ChatGPT and SuperGrok sign-ins pico calls models with itself, and the
// agents pico drives over ACP on their own sign-ins (Claude Code,
// Antigravity). One list, whichever way pico is used.

import { discoverKeys, applyKeys, keyHint } from './keys.js'
import { loadCatalog, extractModels, adhocModel } from './catalog.js'
import { loadXAIModels } from './xai-models.js'
import { xaiConnected, xaiCredentials } from './xai-auth.js'
import { loadCodexModels } from './codex-models.js'
import { loadOpenRouterModels } from './openrouter-models.js'
import { openaiConnected, openaiCredentials } from './openai-auth.js'
import { defaultModel } from './models.js'
import { fuzzyScore } from './fuzzy.js'
import { CLAUDE_CODE_PROVIDER, claudeCodeModels, claudeCodeStatus } from './claude-code/models.js'
import { ANTIGRAVITY_PROVIDER, antigravityModels, antigravityStatus } from './antigravity/models.js'

const CATALOG_PROVIDERS = ['google', 'anthropic', 'openai', 'xai']

function codexContext(catalogData, model) {
  const entry = catalogData.openai?.models?.[model.name.split('/')[1]]
  return model.context ?? entry?.limit?.input ?? entry?.limit?.context ?? null
}

// the models of `providers` (the providers this machine has keys or
// sign-ins for), each marked available or not
export async function buildModels({ providers, force = false, agy = null }) {
  if (providers.includes(ANTIGRAVITY_PROVIDER) && !agy) agy = await antigravityStatus().catch(() => ({ models: [] }))
  const has = (provider) => providers.includes(provider)
  const codexCredentials = has('codex') ? await openaiCredentials().catch(() => null) : null
  const subscriptionCredentials = has('grok') ? await xaiCredentials().catch(() => null) : null
  const [catalogData, codex, openrouter, grok] = await Promise.all([
    loadCatalog({ force }),
    loadCodexModels(codexCredentials, { force }),
    has('openrouter') ? loadOpenRouterModels({ force }) : [],
    loadXAIModels(subscriptionCredentials, { force }),
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
    ...grok.map(model => ({ ...model, available: has('grok'), keyHint: '/connect' })),
    ...openrouter.map((model) => ({ ...model, available: true, keyHint: keyHint('openrouter') })),
    ...(has(CLAUDE_CODE_PROVIDER) ? claudeCodeModels() : []),
    ...(has(ANTIGRAVITY_PROVIDER) ? antigravityModels(agy.models) : []),
  ]
}

export async function loadModelRuntime() {
  const [chatgpt, grok, claude, agy] = await Promise.all([
    openaiConnected(),
    xaiConnected(),
    claudeCodeStatus().catch(() => ({ connected: false })),
    antigravityStatus().catch(() => ({ connected: false, models: [] })),
  ])
  const providers = [
    ...applyKeys(discoverKeys()),
    ...(chatgpt ? ['codex'] : []),
    ...(grok.connected ? ['grok'] : []),
    ...(claude.connected ? [CLAUDE_CODE_PROVIDER] : []),
    ...(agy.connected ? [ANTIGRAVITY_PROVIDER] : []),
  ]
  const codexCredentials = chatgpt ? await openaiCredentials().catch(() => null) : null
  const loadModels = ({ force = false } = {}) => buildModels({ providers, force, agy })
  const subscriptionCredentials = grok.connected ? await xaiCredentials().catch(() => null) : null
  return { providers, models: await loadModels(), codexCredentials, xaiCredentials: subscriptionCredentials, loadModels }
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
