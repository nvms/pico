// Antigravity as an ACP agent: Google's `agy acp` already speaks ACP, so
// this adapter passes every message through, and adds only pico's rules
// and what pico knows of agy's tools:
//
// - agy runs without API keys in its environment (process.js), on the
//   Google sign-in it keeps, with no permission prompts
// - pico's instructions reach agy as its own system prompt extension
// - each tool call is labelled with the pico tool it amounts to, from
//   agy's own argument names; a call to the client's MCP server, and one
//   that starts a subagent, say so
// - a permission agy means as a question to the person is marked as one
// - the models a session offers are kept as the catalog (models.js)
// - a session opened for one question is removed from agy's history

import { spawnAgent } from '../acp/connect.js'
import { modelsOffered, shortPath } from '../acp/translate.js'
import { AGY_ARGS, agyEnv } from './process.js'
import { agyCommand, writeCatalog } from './models.js'
import { agyDataDir, forgetConversation } from './conversations.js'

const pick = (input, keys) => {
  for (const key of keys) if (input?.[key] != null && input[key] !== '') return input[key]
  return undefined
}
const PATH_KEYS = ['AbsolutePath', 'absolute_path', 'TargetFile', 'target_file', 'FilePath', 'file_path', 'Path', 'path']
const COMMAND_KEYS = ['CommandLine', 'command_line', 'commandLine', 'command']
const CWD_KEYS = ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd']
const SUBAGENT_TOOLS = new Set(['start_subagent', 'invoke_subagent'])

// what an agy tool call names itself by: "Running run_command" while it
// runs, "Run run_command?" while it waits for approval
export function agyToolName(call = {}) {
  return String(call.title ?? '').match(/^(?:Running|Run|Ran)\s+([A-Za-z0-9_.:/-]+)\??$/)?.[1] ?? null
}

// the MCP tool a call reached, when it went to one of `servers`: agy names
// it with the server's name before the tool's
export function mcpTool(call = {}, servers = []) {
  const name = agyToolName(call) ?? String(call.title ?? '')
  for (const server of servers) {
    const match = name.match(new RegExp(`^(?:mcp[_:/.]+)?${server}[_:/.]+(.+)$`))
    if (match) return match[1]
  }
  return null
}

// the pico tool an agy tool call amounts to
export function picoTool(call = {}, cwd, servers = []) {
  const input = call.rawInput ?? {}
  const bridged = mcpTool(call, servers)
  if (bridged) return { tool: { name: bridged, args: input }, bridged: true }
  const tool = agyToolName(call)
  if (tool && SUBAGENT_TOOLS.has(tool)) {
    const description = pick(input, ['Description', 'description', 'Role', 'role', 'TaskName', 'task_name'])
    const prompt = pick(input, ['Prompt', 'prompt', 'Task', 'task', 'Instructions', 'instructions']) ?? ''
    return { tool: { name: 'Task', args: { description, prompt } }, subagent: { description, prompt } }
  }
  const path = shortPath(call.locations?.[0]?.path ?? pick(input, PATH_KEYS), cwd)
  switch (call.kind) {
    case 'execute': {
      const at = pick(input, CWD_KEYS)
      return { tool: { name: 'bash', args: { command: pick(input, COMMAND_KEYS) ?? call.title, ...(at ? { cwd: shortPath(at, cwd) } : {}) } } }
    }
    case 'search': return { tool: { name: 'grep', args: { pattern: pick(input, ['Query', 'query', 'Pattern', 'pattern', 'SearchPattern']), ...(path ? { path } : {}) } } }
    case 'fetch': return { tool: { name: 'web_fetch', args: { url: pick(input, ['Url', 'url', 'URL']) ?? call.title } } }
    case 'edit': case 'delete': case 'move': case 'read': return { tool: { name: call.kind, args: { path } } }
    default: return { tool: { name: tool ?? call.kind ?? 'tool', args: input } }
  }
}

// a command's output, which agy reports under its own names rather than
// as the call's content
const OUTPUT_KEYS = ['combinedOutput', 'combined_output', 'output']
export function withOutput(update) {
  if (update.content?.length || !update.rawOutput || typeof update.rawOutput !== 'object') return update
  const text = pick(update.rawOutput, OUTPUT_KEYS)
  return typeof text === 'string' ? { ...update, content: [{ type: 'content', content: { type: 'text', text } }] } : update
}

// a call's location, from agy's own argument names when it gives none
const located = (call) => {
  if (call.locations?.length) return call
  const path = pick(call.rawInput, PATH_KEYS)
  return path ? { ...call, locations: [{ path }] } : call
}

export function connectAntigravity({ cwd, env = {}, onNotification = () => {}, onRequest = async () => null, onExit = () => {}, command = agyCommand() }) {
  // per agy session: the MCP servers it was given, its folder, and
  // whether it is only for one question
  const sessions = new Map()
  const known = (sessionId) => sessions.get(sessionId) ?? { servers: [], cwd, ephemeral: false }

  const normalizeUpdate = (params) => {
    const update = withOutput(params.update ?? {})
    if (update !== params.update) params = { ...params, update }
    if (update.sessionUpdate !== 'tool_call' && !(update.sessionUpdate === 'tool_call_update' && (update.title || update.rawInput))) return params
    const session = known(params.sessionId)
    const call = located(update)
    const meta = picoTool(call, session.cwd, session.servers)
    return { ...params, update: { ...call, _meta: { ...call._meta, pico: { ...call._meta?.pico, ...meta } } } }
  }
  const normalizePermission = (params) => (String(params.toolCall?.toolCallId ?? '').startsWith('interaction_') ? { ...params, _meta: { ...params._meta, pico: { ...params._meta?.pico, question: true } } } : params)

  if (!command) {
    queueMicrotask(() => onExit({ error: new Error('The Antigravity CLI is not installed on this machine'), stderr: '' }))
    return { alive: false, stderr: '', request: () => Promise.reject(new Error('The Antigravity CLI is not installed on this machine')), notify() {}, close() {} }
  }
  const conn = spawnAgent({
    command,
    args: AGY_ARGS,
    cwd,
    env: agyEnv({ ...process.env, ...env }),
    missing: 'The Antigravity CLI is not installed on this machine',
    onNotification: (method, params) => onNotification(method, method === 'session/update' ? normalizeUpdate(params) : params),
    onRequest: (method, params) => onRequest(method, method === 'session/request_permission' ? normalizePermission(params) : params),
    onExit,
  })

  // pico's own session options, as agy takes them
  const outgoing = (params) => {
    const { pico, ...meta } = params._meta ?? {}
    if (!pico) return params
    return { ...params, _meta: { ...meta, ...(pico.systemPrompt ? { antigravity: { ...meta.antigravity, systemPrompt: { append: pico.systemPrompt } } } : {}) } }
  }

  async function request(method, params = {}) {
    const opens = ['session/new', 'session/resume', 'session/load', 'session/fork'].includes(method)
    const result = await conn.request(method, opens ? outgoing(params) : params)
    if (opens) {
      const sessionId = result?.sessionId ?? params.sessionId
      sessions.set(sessionId, { servers: (params.mcpServers ?? []).map((s) => s.name), cwd: params.cwd ?? cwd, ephemeral: !!params._meta?.pico?.ephemeral })
      const models = modelsOffered(result?.configOptions)
      if (models.length) writeCatalog(models)
    }
    if (method === 'session/close' && known(params.sessionId).ephemeral) forgetConversation(params.sessionId, { dir: agyDataDir({ ...process.env, ...env }) })
    return result
  }

  return {
    get alive() { return conn.alive },
    get stderr() { return conn.stderr },
    request,
    notify: conn.notify,
    close: conn.close,
  }
}
