import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

export const XAI_SUBSCRIPTION_URL = 'https://cli-chat-proxy.grok.com/v1'
const TTL = 24 * 60 * 60 * 1000

export function mapXAIModels(entries) {
  return entries.filter(m => typeof m.id === 'string' && m.id.startsWith('grok-') && !/image|video|audio|voice/.test(m.id)).map(m => ({
    name: `grok/${m.id}`,
    provider: 'grok',
    desc: m.description || m.display_name || m.id,
    price: null,
    effort: false,
    context: m.context_window || m.max_context_window || null,
  }))
}

export async function loadXAIModels(credentials, { force = false, fetcher = fetch } = {}) {
  const file = join(picoHome(), 'xai-models-cache.json')
  let cached = null
  try {
    cached = JSON.parse(await readFile(file, 'utf-8'))
    if (!Array.isArray(cached.models)) cached = null
  } catch {}
  if (!credentials?.accessToken || (!force && cached && Date.now() - cached.at < TTL)) return mapXAIModels(cached?.models || [])
  const headers = { Authorization: `Bearer ${credentials.accessToken}` }
  let models
  try {
    const response = await fetcher(`${XAI_SUBSCRIPTION_URL}/models`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`Grok subscription model discovery failed (${response.status})`)
    const data = await response.json()
    if (!Array.isArray(data.data)) throw new Error('invalid subscription model list')
    models = [...new Map(data.data.filter(m => typeof m?.id === 'string').map(m => [m.id, m])).values()]
  } catch (error) {
    if (cached) return mapXAIModels(cached.models)
    throw error
  }
  if (!mapXAIModels(models).length) return mapXAIModels(cached?.models || [])
  try {
    ensureDir(picoHome())
    await writeFile(file, JSON.stringify({ at: Date.now(), models }))
  } catch {}
  return mapXAIModels(models)
}
