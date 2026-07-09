import { existsSync } from 'node:fs'
import { basename } from 'node:path'

const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

export function mediaTypeFor(path) {
  return MEDIA_TYPES[path.split('.').pop().toLowerCase()] || null
}

function unquote(token) {
  if (/^'.*'$/.test(token) || /^".*"$/.test(token)) return token.slice(1, -1)
  return token.replace(/\\ /g, ' ')
}

function toPath(token) {
  const raw = unquote(token.trim())
  if (raw.startsWith('file://')) {
    try {
      return decodeURIComponent(raw.slice('file://'.length))
    } catch {
      return null
    }
  }
  return raw
}

export function extractImagePaths(text, exists = existsSync) {
  const tokens = text.trim().match(/'[^']*'|"[^"]*"|(?:\\ |\S)+/g)
  if (!tokens || tokens.length === 0) return []
  const paths = []
  for (const token of tokens) {
    const path = toPath(token)
    if (!path || !path.startsWith('/')) return []
    if (!mediaTypeFor(path) || !exists(path)) return []
    paths.push(path)
  }
  return paths
}

export function imageLabel(part) {
  if (part.source?.path) return `[image: ${basename(part.source.path)}]`
  return '[image]'
}

export function buildUserContent(text, attachments) {
  const parts = []
  let last = 0
  const used = []
  for (const match of text.matchAll(/\[Image #\d+\]/g)) {
    const attachment = attachments.get(match[0])
    if (!attachment) continue
    const before = text.slice(last, match.index)
    if (before) parts.push({ type: 'text', text: before })
    parts.push({
      type: 'image',
      source: { kind: 'path', path: attachment.path, mediaType: attachment.mediaType },
    })
    used.push(match[0])
    last = match.index + match[0].length
  }
  if (parts.length === 0) return { content: text, used }
  const tail = text.slice(last)
  if (tail) parts.push({ type: 'text', text: tail })
  return { content: parts, used }
}
