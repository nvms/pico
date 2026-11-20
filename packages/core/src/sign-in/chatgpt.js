// ChatGPT's sign-in, for Codex models: pico's own (openai-auth.js). The
// page sends the browser back to a listener on this machine; from a
// browser elsewhere, the address the page ended on is handed to it.

import { connectOpenAI, disconnectOpenAI, openaiStatus } from '../openai-auth.js'

export const status = async () => {
  const s = await openaiStatus().catch(() => ({ connected: false, email: null }))
  return { installed: true, signedIn: !!s.connected, identity: s.email ?? null }
}

export async function start() {
  const controller = new AbortController()
  let shown
  const page = new Promise((resolve) => { shown = resolve })
  const done = connectOpenAI({ openBrowser: false, onUrl: (url) => shown({ url }), signal: controller.signal }).then((r) => ({ identity: r.email ?? null }))
  done.catch(() => {})
  return {
    page,
    input: 'redirect',
    done,
    async finish(address) {
      let back
      try { back = new URL(String(address).trim()) } catch { throw new Error('That is not the address the page ended on') }
      if (!['localhost', '127.0.0.1'].includes(back.hostname) || back.pathname !== '/auth/callback') throw new Error('That is not the address the page ended on')
      await fetch(`http://127.0.0.1:1455${back.pathname}${back.search}`, { signal: AbortSignal.timeout(10000) }).catch(() => {})
    },
    cancel: () => controller.abort(),
  }
}

export const signOut = () => disconnectOpenAI()
