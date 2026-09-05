import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import sharp from 'sharp'

// Conservative application budgets, not claims about every provider's limits.
// OpenAI documents 32px patches and model/detail-specific resizing budgets:
// https://developers.openai.com/api/docs/guides/images-vision
// Claude documents 32MB requests and a 2000px side limit
// above 20 images: https://platform.claude.com/docs/en/build-with-claude/vision
// Apply the same envelope across models, including Codex (whose endpoint
// must not be relied on to perform the documented API's automatic resizing).
export const IMAGE_LIMITS = Object.freeze({
  side: 2000, patches: 1536, count: 20, requestPatches: 12000,
  bytes: 4_000_000, requestBase64Bytes: 20_000_000,
  inputBytes: 64_000_000, inputPixels: 100_000_000,
})
const patches = (w, h) => Math.ceil(w / 32) * Math.ceil(h / 32)

export function imageUnavailable(part, reason) {
  const label = part.source?.kind === 'path' ? part.source.path : 'attached image'
  return { type: 'text', text: `[image unavailable: ${label}; ${reason}. Original unchanged. Use a smaller crop or paginated screenshot, or attach the image again.]` }
}

export function imageDimensions(width, height) {
  let scale = Math.min(1, IMAGE_LIMITS.side / width, IMAGE_LIMITS.side / height,
    Math.sqrt(IMAGE_LIMITS.patches * 32 * 32 / (width * height)))
  let w = Math.max(1, Math.floor(width * scale))
  let h = Math.max(1, Math.floor(height * scale))
  // Rounding UP to patches matters, especially for long, narrow screenshots.
  while (patches(w, h) > IMAGE_LIMITS.patches) {
    scale *= 0.99
    w = Math.max(1, Math.floor(width * scale))
    h = Math.max(1, Math.floor(height * scale))
  }
  return { width: w, height: h }
}

async function imageBytes(source) {
  if (source?.kind === 'path') {
    const file = await open(source.path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('not a regular image file')
      if (stat.size > IMAGE_LIMITS.inputBytes) throw new Error('source exceeds the 64MB safety limit')
      // Bounded even if the file grows after stat.
      const data = Buffer.alloc(Math.min(stat.size + 1, IMAGE_LIMITS.inputBytes + 1))
      let size = 0
      while (size < data.length) {
        const { bytesRead } = await file.read(data, size, data.length - size, null)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > stat.size) throw new Error('image changed while reading; retry')
      return data.subarray(0, size)
    } finally { await file.close() }
  }
  let encoded = source?.kind === 'base64' ? source.data : null
  if (source?.kind === 'url') {
    encoded = /^data:image\/[\w.+-]+;base64,([\s\S]*)$/i.exec(source.url)?.[1]
  }
  if (typeof encoded !== 'string') throw new Error('unvalidated remote or unsupported image source; download it to a local file first')
  if (encoded.length > Math.ceil(IMAGE_LIMITS.inputBytes / 3) * 4) throw new Error('source exceeds the 64MB safety limit')
  encoded = encoded.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('invalid base64 image')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('invalid base64 image')
  return bytes
}

export async function prepareImage(part) {
  try {
    const bytes = await imageBytes(part.source)
    if (!bytes.length) throw new Error('image is empty')
    const options = { limitInputPixels: IMAGE_LIMITS.inputPixels, failOn: 'warning' }
    const metadata = await sharp(bytes, options).metadata()
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error('unsupported image format; use PNG, JPEG, WebP or GIF')
    if (!metadata.width || !metadata.height) throw new Error('invalid image dimensions')
    const rotated = [5, 6, 7, 8].includes(metadata.orientation)
    const dimensions = imageDimensions(rotated ? metadata.height : metadata.width, rotated ? metadata.width : metadata.height)
    // Decode fully: metadata alone accepts truncated/corrupt pixel data. Always
    // emit a static, correctly labelled image; animation uses its first frame.
    const image = sharp(bytes, options).rotate().resize({ ...dimensions, fit: 'fill' })
    let result = await image.png().toBuffer({ resolveWithObject: true })
    let mediaType = 'image/png'
    if (result.data.length > IMAGE_LIMITS.bytes) {
      result = await sharp(result.data).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
      mediaType = 'image/jpeg'
    }
    if (result.data.length > IMAGE_LIMITS.bytes) throw new Error('encoded image exceeds the 4MB safety limit')
    return { part: { type: 'image', source: { kind: 'base64', mediaType, data: result.data.toString('base64') } }, patches: patches(result.info.width, result.info.height) }
  } catch (error) {
    // Do not expose decoder internals or base64 payloads to the model.
    const reason = error.code === 'ENOENT' ? 'file is missing' :
      /^(image |source |invalid |unsupported |unvalidated |not a regular|encoded image)/.test(error.message) ? error.message : 'cannot read or decode image safely'
    return { part: imageUnavailable(part, reason), patches: 0 }
  }
}

// Sequential and newest-first: bound decoder memory, and retain the images
// relevant to the current task rather than letting old history exhaust budgets.
export async function prepareImages(history) {
  const out = history.map(message => Array.isArray(message.content) ? { ...message, content: [...message.content] } : message)
  let count = 0, totalPatches = 0, totalBytes = 0
  for (let m = out.length - 1; m >= 0; m--) {
    const content = out[m].content
    if (!Array.isArray(content)) continue
    for (let p = content.length - 1; p >= 0; p--) {
      const original = content[p]
      if (original.type !== 'image') continue
      if (count >= IMAGE_LIMITS.count) {
        content[p] = imageUnavailable(original, 'request image count safety budget reached; newest images retained')
        continue
      }
      const prepared = await prepareImage(original)
      const size = prepared.part.source?.data.length || 0
      if (totalPatches + prepared.patches > IMAGE_LIMITS.requestPatches || totalBytes + size > IMAGE_LIMITS.requestBase64Bytes) {
        content[p] = imageUnavailable(original, 'request image safety budget reached; newer images take priority')
        continue
      }
      content[p] = prepared.part
      if (prepared.part.type === 'image') count++
      totalPatches += prepared.patches
      totalBytes += size
    }
  }
  return out
}
