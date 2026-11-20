// SuperGrok's sign-in, for Grok models: pico's own (xai-auth.js), a device
// code shown with its page, entered there; nothing comes back by hand.

import { connectXAI, disconnectXAI, xaiConnected } from '../xai-auth.js'

export const status = async () => {
  const s = await xaiConnected().catch(() => ({ connected: false, email: null }))
  return { installed: true, signedIn: !!s.connected, identity: s.email ?? null }
}

export async function start() {
  const controller = new AbortController()
  let shown
  const page = new Promise((resolve) => { shown = resolve })
  const done = connectXAI({ openBrowser: false, onUrl: (url, code) => shown({ url, code }), signal: controller.signal })
    .then((r) => ({ identity: r?.email ?? null }), (error) => { throw controller.signal.aborted ? new Error('cancelled') : error })
  done.catch(() => {})
  return { page, input: null, done, finish: async () => {}, cancel: () => controller.abort() }
}

export const signOut = () => disconnectXAI()
