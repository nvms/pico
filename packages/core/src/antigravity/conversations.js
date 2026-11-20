// agy keeps every conversation it has, for its own history. A session pico
// opens only to sign in, or to answer one question outside any
// conversation, is not one the person had, so it is removed afterward.

import { rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function agyDataDir(env = process.env) {
  return join(env.GEMINI_HOME || join(homedir(), '.gemini'), 'antigravity-cli')
}

export function forgetConversation(sessionId, { dir = agyDataDir() } = {}) {
  if (!ID.test(String(sessionId))) return
  const conversations = join(dir, 'conversations')
  try {
    for (const name of readdirSync(conversations)) if (name.startsWith(`${sessionId}.`)) rmSync(join(conversations, name), { force: true })
  } catch {}
  rmSync(join(dir, 'brain', sessionId), { recursive: true, force: true })
}
