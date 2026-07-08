const CATALOG = [
  { name: 'google/gemini-2.5-pro', provider: 'google', desc: 'Strong reasoning, long context', price: { in: 1.25, out: 10 }, effort: true },
  { name: 'google/gemini-2.5-flash', provider: 'google', desc: 'Fast and capable for everyday work', price: { in: 0.3, out: 2.5 }, effort: true },
  { name: 'google/gemini-2.5-flash-lite', provider: 'google', desc: 'Lowest latency and cost', price: { in: 0.1, out: 0.4 }, effort: true },
  { name: 'anthropic/claude-opus-4-8', provider: 'anthropic', desc: 'Frontier coding and agentic workflows', price: { in: 15, out: 75 }, effort: true },
  { name: 'anthropic/claude-sonnet-5', provider: 'anthropic', desc: 'Balanced speed and capability', price: { in: 3, out: 15 }, effort: true },
  { name: 'anthropic/claude-haiku-4-5', provider: 'anthropic', desc: 'Fastest, for light interactive tasks', price: { in: 1, out: 5 }, effort: true },
  { name: 'openai/gpt-5.2', provider: 'openai', desc: 'Strong general reasoning and tool use', price: { in: 10, out: 40 }, effort: true },
  { name: 'openai/gpt-5.2-mini', provider: 'openai', desc: 'Small and quick for everyday edits', price: { in: 0.6, out: 2.4 }, effort: true },
  { name: 'xai/grok-4', provider: 'xai', desc: 'Realtime knowledge, strong reasoning', price: { in: 5, out: 25 }, effort: false },
]

export function availableModels(providerIds) {
  return CATALOG.filter((m) => providerIds.includes(m.provider))
}

export function findModel(name) {
  return CATALOG.find((m) => m.name === name) || null
}

export function defaultModel(providerIds) {
  return availableModels(providerIds)[0] || null
}

export function estimateCost(model, usage) {
  if (!model?.price || !usage) return 0
  const inCost = (usage.promptTokens || 0) * model.price.in
  const outCost = (usage.completionTokens || 0) * model.price.out
  return (inCost + outCost) / 1e6
}
