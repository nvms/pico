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

export async function captureRegion() {
  if (process.platform !== 'darwin') throw new Error('screen capture is only available on macOS')
  const file = join(await ensureCaptureDir(), `capture-${Date.now()}.png`)
  await new Promise((resolve, reject) => {
    execFile('screencapture', ['-i', '-x', file], (error) => {
      if (!error || !existsSync(file)) resolve()
      else reject(error)
    })
  })
  if (!existsSync(file)) return null
  return {
    path: file,
    dispose: () => unlink(file).catch(() => {}),
  }
}
