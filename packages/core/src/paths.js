import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
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

export function sessionsDir(root) {
  return join(projectDir(root), 'sessions')
}

export function sessionScratchDir(root, sessionId) {
  return join(projectDir(root), 'scratchpads', sessionId)
}

export function agentScratchDir(root, sessionId, agentId) {
  return join(sessionScratchDir(root, sessionId), `agent-${agentId}`)
}

export function projectHistoryFile(root) {
  return join(projectDir(root), 'history.jsonl')
}

export function projectMcpFile(root) {
  return join(projectDir(root), 'mcp.json')
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
