import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export function picoHome() {
  return process.env.PICO_HOME || join(homedir(), '.pico')
}

export function projectKey(root) {
  return resolve(root).replace(/[/\\:]/g, '-')
}

export function findProjectRoot(cwd) {
  let dir = resolve(cwd)
  const home = homedir()
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir || dir === home) return resolve(cwd)
    dir = parent
  }
}

export function projectDir(root) {
  return join(picoHome(), 'projects', projectKey(root))
}

// a git worktree shares its repository's memories, mcp config, and prompt
// history, so those key by the checkout that owns the shared git dir. a
// main checkout, or a folder without git, keys by itself as before
const owners = new Map()
export function ownerRoot(root) {
  const key = resolve(root)
  if (owners.has(key)) return owners.get(key)
  let owner = key
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: key, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: key, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const candidate = dirname(common)
    if (top === key && candidate !== top) owner = candidate
  } catch {}
  owners.set(key, owner)
  return owner
}

export function sharedProjectDir(root) {
  return projectDir(ownerRoot(root))
}

export function sessionsDir(root) {
  return join(projectDir(root), 'sessions')
}

export function sessionScratchDir(root, sessionId) {
  return join(projectDir(root), 'scratchpads', sessionId)
}

export function sessionAttachmentsDir(root, sessionId) {
  return join(projectDir(root), 'attachments', sessionId)
}

export function agentScratchDir(root, sessionId, agentId) {
  return join(sessionScratchDir(root, sessionId), `agent-${agentId}`)
}

export function projectHistoryFile(root) {
  return join(sharedProjectDir(root), 'history.jsonl')
}

export function projectMcpFile(root) {
  return join(sharedProjectDir(root), 'mcp.json')
}

export function globalMcpFile() {
  return join(picoHome(), 'mcp.json')
}

export function globalSkillsDir() {
  return join(picoHome(), 'skills')
}

export function projectSkillsDir(root) {
  return join(root, '.pico', 'skills')
}

export function globalAgentsFile() {
  return join(picoHome(), 'AGENTS.md')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}
