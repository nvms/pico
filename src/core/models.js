export function findModel(models, name) {
  return models.find((m) => m.name === name) || null
}

export function defaultModel(models) {
  return models[0] || null
}

export function estimateCost(model, usage) {
  if (!model?.price || !usage) return 0
  const inCost = (usage.promptTokens || 0) * model.price.in
  const outCost = (usage.completionTokens || 0) * model.price.out
  return (inCost + outCost) / 1e6
}
