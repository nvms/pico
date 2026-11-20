#!/usr/bin/env node
// a stand-in for `agy acp`, as the Antigravity adapter's tests drive it:
// it records what it is sent and what it runs with, and answers a prompt
// with agy's own shapes
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const log = (entry) => appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`)
log({ args: process.argv.slice(2), apiKey: process.env.GEMINI_API_KEY ?? null })
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId, u) => write({ method: 'session/update', params: { sessionId, update: u } })
const waiting = new Map()
let seq = 100

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (!message.method) { waiting.get(message.id)?.(message.result); return }
  log({ method: message.method, params: message.params })
  const reply = (result) => write({ id: message.id, result })
  if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } })
  if (message.method === 'session/new') {
    const sessionId = '0b5e3c2a-1111-4222-8333-944455556666'
    const dir = join(process.env.GEMINI_HOME, 'antigravity-cli', 'conversations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.db`), '')
    return reply({ sessionId, configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] }] })
  }
  if (message.method === 'session/prompt') {
    const { sessionId } = message.params
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Running run_command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'ls', Cwd: '/w/src' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { combinedOutput: 'a.txt', exitCode: 0 } })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Running pico_peer_send', kind: 'other', status: 'in_progress', rawInput: { to: 'x' } })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Running view_file', kind: 'read', status: 'in_progress', rawInput: { AbsolutePath: '/w/README.md' } })
    const id = ++seq
    const answer = new Promise((resolve) => waiting.set(id, resolve))
    write({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'interaction_7', title: 'Which port?' }, options: [{ optionId: 'a', name: '3000', kind: 'allow_once' }] } })
    log({ answered: await answer })
    return reply({ stopReason: 'end_turn' })
  }
  if (message.method === 'session/close') return reply({})
  reply(null)
})
