// One headless Claude Code process speaking stream-json on stdin and
// stdout: user messages go in, every event comes out as a line of JSON.
// Control requests (initialize, interrupt) use the same protocol the
// Claude Agent SDK uses to drive the CLI.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

// these make Claude Code bill an API key instead of the claude.ai login,
// silently; a Claude Code session in pico always runs on the subscription
const API_AUTH_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

export function claudeEnv(env = process.env) {
  const out = { ...env }
  for (const key of API_AUTH_VARIABLES) delete out[key]
  // set inside a Claude Code session; the child is its own session
  delete out.CLAUDECODE
  return out
}

// tools Claude Code would otherwise use in place of pico's: questions go
// through ask_user so they reach pico's question card, and worktrees are
// the host's to manage
const DISALLOWED = ['AskUserQuestion', 'EnterWorktree', 'ExitWorktree']

// `oneShot` is a bare run with no tools and nothing saved, for work like
// summarizing that is not part of the conversation
export function claudeArgs({ model, effort, resume, fork, mcpConfig, appendSystemPrompt, oneShot = false }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // pico and its hosts run without permission prompts, as the user runs
    // Claude Code itself
    '--dangerously-skip-permissions',
    '--disallowedTools', DISALLOWED.join(','),
  ]
  if (oneShot) args.push('--tools', '', '--no-session-persistence', '--strict-mcp-config')
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (resume) args.push('--resume', resume)
  if (resume && fork) args.push('--fork-session')
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig))
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
  return args
}

export function spawnClaude({ command = 'claude', cwd, env, onMessage, onExit, ...options }) {
  const child = spawn(command, claudeArgs(options), { cwd, env: claudeEnv({ ...process.env, ...env }), stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let stderr = ''
  let exited = false

  const write = (message) => {
    if (exited || !child.stdin.writable) return false
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.type === 'control_response') {
      const id = message.response?.request_id
      const waiter = pending.get(id)
      pending.delete(id)
      if (message.response.subtype === 'error') waiter?.reject(new Error(message.response.error || 'control request failed'))
      else waiter?.resolve(message.response.response ?? null)
      return
    }
    if (message.type === 'control_request') {
      // permissions are skipped, so a tool request should never come; if
      // one does, it is allowed rather than left to hang the turn
      const request = message.request ?? {}
      const response = request.subtype === 'can_use_tool'
        ? { subtype: 'success', request_id: message.request_id, response: { behavior: 'allow', updatedInput: request.input } }
        : { subtype: 'error', request_id: message.request_id, error: `pico does not handle ${request.subtype}` }
      write({ type: 'control_response', response })
      return
    }
    onMessage(message)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  child.stdin.on('error', () => {})

  const finish = (error) => {
    if (exited) return
    exited = true
    for (const waiter of pending.values()) waiter.reject(new Error('Claude Code exited'))
    pending.clear()
    onExit?.({ error, stderr: stderr.trim() })
  }
  child.on('error', (error) => finish(error.code === 'ENOENT' ? new Error(`${command} not found; install Claude Code and sign in with claude auth login`) : error))
  child.on('exit', (code, signal) => finish(code === 0 || signal === 'SIGTERM' ? null : new Error(`Claude Code exited with ${signal ?? `code ${code}`}`)))

  function request(subtype, payload = {}) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (!write({ type: 'control_request', request_id: id, request: { subtype, ...payload } })) {
        pending.delete(id)
        reject(new Error('Claude Code is not running'))
      }
    })
  }

  request('initialize').catch(() => {})

  return {
    get alive() { return !exited },
    get stderr() { return stderr.trim() },
    send: (content) => write({ type: 'user', message: { role: 'user', content } }),
    interrupt: () => request('interrupt'),
    close() {
      if (exited) return
      child.stdin.end()
      setTimeout(() => { if (!exited) child.kill('SIGTERM') }, 3000).unref()
    },
  }
}
