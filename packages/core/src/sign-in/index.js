// Every sign-in pico makes to use a subscription, one per provider, each
// the same five calls:
//
// - status(): { installed, signedIn, identity, error? }
// - start(): a sign-in under way, { page, input, finish, done, cancel }:
//   `page` resolves to { url, code? }, the page to open (and a code to
//   enter there); `input` says what the person brings back from it by
//   hand, 'code', 'redirect' (the address the page ended on, from a
//   browser on another device) or null; `finish(text)` hands that in;
//   `done` resolves to { identity, token? } once signed in
// - signOut()
// - install(), where pico can install the agent a sign-in is for
//
// Keyed by the provider whose models the sign-in opens up.

import * as claudeCode from './claude-code.js'
import * as chatgpt from './chatgpt.js'
import * as supergrok from './supergrok.js'
import * as antigravity from './antigravity.js'

export const SIGN_INS = {
  'claude-code': { label: 'Claude Code', ...claudeCode },
  codex: { label: 'ChatGPT', ...chatgpt },
  grok: { label: 'SuperGrok', ...supergrok },
  antigravity: { label: 'Antigravity', ...antigravity },
}

export function signInFor(provider) {
  const found = SIGN_INS[provider]
  if (!found) throw new Error(`no sign-in for ${provider}`)
  return found
}
