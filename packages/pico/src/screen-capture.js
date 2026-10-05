import { execFile } from 'node:child_process'
import { mkdtemp, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let captureDir = null

async function ensureCaptureDir() {
  captureDir ??= await mkdtemp(join(tmpdir(), 'pico-capture-'))
  return captureDir
}

export function captureCommands(platform, file, env = process.env) {
  if (platform === 'darwin') return [['screencapture', ['-i', '-x', file]]]
  if (platform === 'linux') {
    if (env.XDG_SESSION_TYPE === 'wayland') {
      return [['gnome-screenshot', ['-a', '-f', file]], ['spectacle', ['-r', '-b', '-n', '-o', file]]]
    }
    return [
      ['xfce4-screenshooter', ['--region', '--save', file]],
      ['gnome-screenshot', ['-a', '-f', file]],
      ['scrot', ['--select', file]],
    ]
  }
  throw new Error('screen capture requires macOS or Linux')
}

export async function captureRegion({ platform = process.platform, env = process.env, run = execFile, exists = existsSync } = {}) {
  const file = join(await ensureCaptureDir(), `capture-${Date.now()}.png`)
  const commands = captureCommands(platform, file, env)
  for (const [command, args] of commands) {
    const error = await new Promise(resolve => {
      run(command, args, error => resolve(error))
    })
    // Try another backend only when the executable is missing, not on cancel.
    if (error?.code === 'ENOENT') continue
    if (!exists(file)) {
      if (error && platform !== 'darwin') {
        const detail = error.stderr || error.message || String(error)
        if (error.code !== 1) throw new Error(`screen capture failed: ${detail}`)
      }
      return null
    }
    if (error) {
      await unlink(file).catch(() => {})
      throw error
    }
    return { path: file, dispose: () => unlink(file).catch(() => {}) }
  }
  throw new Error(env.XDG_SESSION_TYPE === 'wayland'
    ? 'Install gnome-screenshot or spectacle for Linux region capture. Support depends on your Wayland compositor.'
    : 'Install a region capture tool: sudo apt install xfce4-screenshooter (or gnome-screenshot / scrot).')
}
