import { setKeys } from '@prsm/ai'

const PROVIDERS = [
  { id: 'google', label: 'Gemini', env: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'] },
  { id: 'anthropic', label: 'Claude', env: ['ANTHROPIC_API_KEY'] },
  { id: 'openai', label: 'OpenAI', env: ['OPENAI_API_KEY'] },
  { id: 'xai', label: 'Grok', env: ['XAI_API_KEY'] },
]

export function discoverKeys(env = process.env) {
  const keys = {}
  for (const p of PROVIDERS) {
    const name = p.env.find((n) => env[n])
    if (name) keys[p.id] = env[name]
  }
  return keys
}

export function applyKeys(keys) {
  setKeys(keys)
  return Object.keys(keys)
}
