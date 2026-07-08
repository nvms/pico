import { execFile } from 'node:child_process'
import fg from 'fast-glob'

const MAX_FILES = 5000
const TTL = 5000

let cached = { at: 0, cwd: null, files: [] }

function ripgrepFiles(cwd) {
  return new Promise((resolve) => {
    execFile('rg', ['--files', '--sortr=modified'], { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? null : stdout.split('\n').filter(Boolean))
    })
  })
}

export async function listFiles(cwd) {
  if (cached.cwd === cwd && Date.now() - cached.at < TTL) return cached.files
  let files = await ripgrepFiles(cwd)
  if (!files) {
    files = await fg('**/*', {
      cwd,
      onlyFiles: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    }).catch(() => [])
  }
  cached = { at: Date.now(), cwd, files: files.slice(0, MAX_FILES) }
  return cached.files
}
