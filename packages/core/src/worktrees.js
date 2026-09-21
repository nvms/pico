import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { ownerRoot, picoHome, projectKey } from './paths.js'

const exec = promisify(execFile)
const ADJECTIVES = ['quiet', 'brisk', 'amber', 'lucid', 'mellow', 'nimble', 'rustic', 'silent', 'vivid', 'gentle', 'bold', 'calm', 'clever', 'crisp', 'eager', 'fair', 'keen', 'plain', 'sly', 'warm']
const ANIMALS = ['otter', 'heron', 'lynx', 'finch', 'badger', 'marten', 'plover', 'stoat', 'wren', 'tern', 'vole', 'ibis', 'kite', 'newt', 'orca', 'pika', 'quail', 'raven', 'shrew', 'yak']

async function git(cwd, args) {
  const { stdout } = await exec('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

export function parseWorktrees(output) {
  return output.split('\n\n').map((block) => {
    const lines = block.split('\n').filter(Boolean)
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    const branch = lines.find((line) => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null
    return path ? { path, branch, detached: lines.includes('detached') } : null
  }).filter(Boolean)
}

export async function listWorktrees(root) {
  try {
    return parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']))
  } catch {
    return []
  }
}

function worktreeName(taken) {
  for (let i = 0; i < 200; i++) {
    const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`
    if (!taken.has(name)) return name
  }
  return `tree-${Date.now().toString(36)}`
}

export async function createWorktree(root) {
  const owner = ownerRoot(root)
  const existing = await listWorktrees(owner)
  const name = worktreeName(new Set(existing.map((tree) => basename(tree.path))))
  const path = join(picoHome(), 'worktrees', projectKey(owner), name)
  const branch = `wt/${name}`
  await mkdir(dirname(path), { recursive: true })
  await git(root, ['worktree', 'add', '-b', branch, path])
  const created = (await listWorktrees(owner)).find((tree) => tree.branch === branch)
  return { path: created?.path ?? path, branch, owner }
}

export async function removeWorktree(root, path) {
  const owner = ownerRoot(root)
  if (path === owner) throw new Error('the main checkout is not a worktree')
  const tree = (await listWorktrees(owner)).find((entry) => entry.path === path)
  if (!tree) throw new Error('worktree not found')
  await git(owner, ['worktree', 'remove', path])
  if (tree.branch?.startsWith('wt/')) await git(owner, ['branch', '-d', tree.branch]).catch(() => {})
  return tree
}
