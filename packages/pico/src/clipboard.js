import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execute = promisify(execFile)
const directories = new Set()
process.once('exit', () => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
})

const macScript = `ObjC.import('AppKit');
const image = $.NSImage.alloc.initWithPasteboard($.NSPasteboard.generalPasteboard);
if (image.isNil()) { '' } else {
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`

const windowsScript = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage();
  $stream = New-Object System.IO.MemoryStream;
  try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) }
  finally { $stream.Dispose(); $image.Dispose() }
}`

export async function readClipboardImage({ platform = process.platform, env = process.env, run = execute } = {}) {
  if (env.SSH_CONNECTION || env.SSH_TTY) throw new Error('clipboard images are unavailable over SSH')
  const options = { encoding: 'buffer', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }
  let data
  try {
    if (platform === 'darwin') {
      const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', macScript], options)
      data = Buffer.from(stdout.toString().trim(), 'base64')
    } else if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', windowsScript], options)
      data = Buffer.from(stdout.toString().trim(), 'base64')
    } else if (platform === 'linux') {
      const wayland = Boolean(env.WAYLAND_DISPLAY)
      const command = wayland ? 'wl-paste' : 'xclip'
      const { stdout: types } = await run(command, wayland ? ['--list-types'] : ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], options)
      if (!types.toString().split(/\s+/).includes('image/png')) return null
      const { stdout } = await run(command, wayland ? ['--type', 'image/png', '--no-newline'] : ['-selection', 'clipboard', '-t', 'image/png', '-o'], options)
      data = Buffer.from(stdout)
    } else {
      throw new Error('clipboard images are unsupported on this platform')
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('clipboard reader unavailable: install ' + (env.WAYLAND_DISPLAY ? 'wl-clipboard' : platform === 'linux' ? 'xclip' : 'the system clipboard tools'))
    throw error
  }
  if (!data.length) return null
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('clipboard did not return a PNG image')
  const dir = await mkdtemp(join(tmpdir(), 'pico-clipboard-'))
  directories.add(dir)
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true })
    directories.delete(dir)
  }
  const path = join(dir, 'clipboard.png')
  try {
    await writeFile(path, data, { mode: 0o600 })
    return { path, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
