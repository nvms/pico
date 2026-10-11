import { openaiCredentials } from './openai-auth.js'
import { xaiCredentials } from './xai-auth.js'
import { XAI_SUBSCRIPTION_URL } from './xai-models.js'

export function subscriptionProvider(provider) {
  return provider === 'codex' || provider === 'grok'
}

export async function modelCredentials(model) {
  if (model.provider === 'codex') return openaiCredentials()
  if (model.provider === 'grok') return xaiCredentials()
  return null
}

export function modelRequest(modelName, auth) {
  if (!modelName.startsWith('grok/')) {
    return {
      model: modelName,
      ...(auth?.apiKey && { apiKey: auth.apiKey }),
      ...(auth?.headers && { headers: auth.headers }),
    }
  }
  const token = auth?.accessToken
  if (!token) throw new Error('Grok subscription models need a SuperGrok sign-in (/connect)')
  // The Codex adapter implements the subscription Responses wire protocol.
  return {
    model: `codex/${modelName.slice('grok/'.length)}`,
    baseUrl: XAI_SUBSCRIPTION_URL,
    apiKey: token,
    headers: { originator: 'pico', 'OpenAI-Beta': '', 'x-grok-client-mode': 'cli', 'x-grok-client-version': '1.0.13' },
  }
}
