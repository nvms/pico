import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { picoHome, ensureDir } from './paths.js'

// the backend hides models from clients below a version floor, so send a
// version comfortably above it
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=2.0.0'
const TTL = 24 * 60 * 60 * 1000

const FALLBACK = [
  { slug: 'gpt-5.6-sol', description: 'Latest frontier agentic coding model.' },
  { slug: 'gpt-5.6-terra', description: 'Balanced agentic coding model for everyday work.' },
  { slug: 'gpt-5.6-luna', description: 'Fast and affordable agentic coding model.' },
  { slug: 'gpt-5.5', description: 'Frontier model for complex coding, research, and real-world work.' },
  { slug: 'gpt-5.4', description: 'Strong model for everyday coding.' },
  { slug: 'gpt-5.4-mini', description: 'Small, fast, and cost-efficient model for simpler coding tasks.' },
  { slug: 'gpt-5.3-codex-spark', description: 'Ultra-fast coding model.' },
]

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
    context: null,
  }))
}

export async function loadCodexModels(credentials) {
  let cached = null
  try {
    cached = JSON.parse(await readFile(cacheFile(), 'utf-8'))
  } catch {}
  if (cached && Date.now() - cached.at < TTL) return mapCodexModels(cached.models)
  if (!credentials) return mapCodexModels(cached?.models || FALLBACK)

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
    const models = (data.models || []).map((m) => ({ slug: m.slug, description: m.description, label: m.label }))
    if (models.length === 0) throw new Error('empty model list')
    ensureDir(picoHome())
    await writeFile(cacheFile(), JSON.stringify({ at: Date.now(), models }))
    return mapCodexModels(models)
  } catch {
    return mapCodexModels(cached?.models || FALLBACK)
  }
}
