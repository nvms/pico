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
  const tokens = text.trim().match(/'[^']*'|"[^"]*"|(?:\\ |[^ \t\n\r])+/g)
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

const IMAGE_PATH_RE = /(["'])(\/[^"']+?\.(?:png|jpe?g|gif|webp|bmp))\1|(\/(?:\\ |[^ \t\n\r"'])+\.(?:png|jpe?g|gif|webp|bmp))/gi

export function splitTextByImagePaths(text, exists = existsSync) {
  const parts = []
  let last = 0
  for (const match of text.matchAll(IMAGE_PATH_RE)) {
    const path = match[2] || match[3].replace(/\\ /g, ' ')
    const mediaType = mediaTypeFor(path)
    if (!mediaType || !exists(path)) continue
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    parts.push({ type: 'image', source: { kind: 'path', path, mediaType } })
    last = match.index + match[0].length
  }
  if (parts.length === 0) return null
  const tail = text.slice(last)
  if (tail) parts.push({ type: 'text', text: tail })
  return parts
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

export function placeholderizeImagePaths(text, { attachments, nextId, exists = existsSync }) {
  const parts = splitTextByImagePaths(text, exists)
  if (!parts) return { text, changed: false }
  let out = ''
  for (const part of parts) {
    if (part.type === 'text') {
      out += part.text
    } else {
      const placeholder = `[Image #${nextId()}]`
      attachments.set(placeholder, { path: part.source.path, mediaType: part.source.mediaType })
      out += placeholder
    }
  }
  return { text: out, changed: true }
}

export function finalizeUserContent(text, attachments, exists = existsSync) {
  const { content, used } = buildUserContent(text, attachments)
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }]
  const expanded = []
  for (const part of parts) {
    if (part.type !== 'text') {
      expanded.push(part)
      continue
    }
    const split = splitTextByImagePaths(part.text, exists)
    if (split) expanded.push(...split)
    else expanded.push(part)
  }
  if (expanded.length === 1 && expanded[0].type === 'text') return { content: expanded[0].text, used }
  return { content: expanded, used }
}
