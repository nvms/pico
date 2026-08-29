import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describeParam } from './recorder.js'
import { mediaTypeFor } from '../attachments.js'

const run = (cmd, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)))
  })

const isPdf = (path) => /\.pdf$/i.test(path)

async function scratch(sessionId) {
  const dir = join(tmpdir(), 'pico-view', String(sessionId || 'session'))
  await mkdir(dir, { recursive: true })
  return dir
}

// a page rendered by poppler, or one of the images embedded on it
async function renderPage(full, page, dir) {
  const prefix = join(dir, `page-${Date.now()}`)
  await run('pdftoppm', ['-png', '-r', '110', '-f', String(page), '-l', String(page), '-singlefile', full, prefix])
  return `${prefix}.png`
}

async function extractImage(full, page, index, dir) {
  const prefix = join(dir, `img-${Date.now()}`)
  await run('pdfimages', ['-png', '-f', String(page), '-l', String(page), full, prefix])
  const files = (await readdir(dir)).filter((f) => f.startsWith(`${prefix.slice(dir.length + 1)}-`)).sort()
  const file = files[index]
  if (!file) throw new Error(`page ${page} has ${files.length} embedded image${files.length === 1 ? '' : 's'}; image index ${index} does not exist`)
  return join(dir, file)
}

// the model api cannot carry an image inside a tool result, so the tool
// hands the image to the viewer, which delivers it as the next user message
// right after this call
export function createView({ cwd, sessionId, recorder, viewer }) {
  return {
    name: 'view',
    description: 'Look at an image. Pass an image file path, or a pdf path with a page number to see that page rendered (add image to pick one embedded image on that page, 0-based, as listed by read). The image arrives in the next user message.',
    schema: {
      description: describeParam,
      path: { type: 'string', description: 'image or pdf path, relative to the working directory or absolute' },
      page: { type: 'number', description: 'pdf page to render, 1-based', optional: true },
      image: { type: 'number', description: 'embedded image index on that page, 0-based; omit to render the whole page', optional: true },
    },
    execute: async ({ path, page, image }) => {
      const full = resolve(cwd, path)
      recorder.extra({ title: page != null ? `${path} page ${page}${image != null ? ` image ${image}` : ''}` : path })
      if (!existsSync(full)) throw new Error(`${path} does not exist`)
      let file = full
      let label = `[view: ${path}]`
      if (isPdf(full)) {
        if (page == null) throw new Error('a pdf needs a page number')
        const dir = await scratch(sessionId)
        file = image != null ? await extractImage(full, page, image, dir) : await renderPage(full, page, dir)
        label = `[view: ${path}, page ${page}${image != null ? `, image ${image}` : ''}]`
      } else if (!mediaTypeFor(full)) {
        throw new Error(`${path} is not an image or pdf`)
      }
      const delivered = viewer.deliver(file, label)
      if (!delivered) throw new Error('could not attach the image')
      return { ok: true, note: 'the image follows in the next user message' }
    },
  }
}
