import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../src/core/catalog-snapshot.json', import.meta.url))
const SUPPORTED = ['google', 'anthropic', 'openai', 'xai']

try {
  const response = await fetch('https://models.dev/api.json')
  if (!response.ok) throw new Error(String(response.status))
  const data = await response.json()
  const providers = {}
  for (const provider of SUPPORTED) {
    if (data[provider]?.models) providers[provider] = { models: data[provider].models }
  }
  await writeFile(out, JSON.stringify(providers))
  console.log(`catalog snapshot written (${Object.keys(providers).join(', ')})`)
} catch (err) {
  if (existsSync(out)) {
    console.warn(`catalog refresh failed (${err.message}), keeping existing snapshot`)
  } else {
    console.error(`catalog snapshot failed and none exists: ${err.message}`)
    process.exit(1)
  }
}
