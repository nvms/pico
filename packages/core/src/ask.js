// One question to any model, answered as text, for hosts that need a quick
// answer outside a session (a title, a summary). A model an engine runs
// (engines.js) is asked through that engine; any other through its
// provider's API.

import { compose, model, getText } from '@prsm/ai'
import { engineFor } from './engines.js'
import { modelCredentials, modelRequest, subscriptionProvider } from './model-auth.js'

export async function ask({ model: chosen, system = '', prompt, effort = null, signal }) {
  const engine = engineFor(chosen)
  if (engine?.ask) return engine.ask({ modelName: chosen.name, system, prompt, effort, signal })
  const auth = subscriptionProvider(chosen.provider) ? await modelCredentials(chosen) : null
  const out = await compose(
    model({ ...modelRequest(chosen.name, auth), ...(system ? { system } : {}), ...(effort ? { effort } : {}) }),
  )(prompt)
  return getText(out.lastResponse?.content || '')
}
