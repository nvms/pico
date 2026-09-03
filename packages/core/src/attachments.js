import { existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

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

export const fileLabel = (path) => `[file: ${path}]`
export const selectionLabel = (part) => `[selection: ${part.path}:${part.fromLine}-${part.toLine}]\n${part.text}\n[/selection]`
export const commitLabel = (part) => `[commit: ${part.hash.slice(0, 7)} ${JSON.stringify(part.subject ?? '')}]`
// a page element the user picked in a browser: where it is, what it is,
// and its markup, so the model can find it in the source
export const elementLabel = (part) => `[element: <${part.tag}> ${part.selector} on ${part.url}${part.component ? ` in component ${part.component}` : ''}]\n${part.html}\n[/element]`

// [Image #n] and [File #n] placeholders in the composed text stand for
// attachments; they become image, file, or selection parts of the user message
export function buildUserContent(text, attachments) {
  const parts = []
  let last = 0
  const used = []
  for (const match of text.matchAll(/\[(?:Image|File) #\d+\]/g)) {
    const attachment = attachments.get(match[0])
    if (!attachment) continue
    const before = text.slice(last, match.index)
    if (before) parts.push({ type: 'text', text: before })
    parts.push(attachment.kind === 'selection'
      ? { type: 'selection', path: attachment.path, text: attachment.text, fromLine: attachment.fromLine, toLine: attachment.toLine, ...(Number.isInteger(attachment.fromColumn) ? { fromColumn: attachment.fromColumn } : {}), ...(Number.isInteger(attachment.toColumn) ? { toColumn: attachment.toColumn } : {}) }
      : attachment.kind === 'commit'
        ? { type: 'commit', hash: attachment.hash, subject: attachment.subject, root: attachment.root }
      : attachment.kind === 'element'
        ? { type: 'element', url: attachment.url, selector: attachment.selector, tag: attachment.tag, text: attachment.text, html: attachment.html, rect: attachment.rect, component: attachment.component ?? null }
      : attachment.kind === 'file'
        ? { type: 'file', path: attachment.path }
        : { type: 'image', source: { kind: 'path', path: attachment.path, mediaType: attachment.mediaType } })
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
      attachments.set(placeholder, { path: part.source.path, mediaType: part.source.mediaType || mediaTypeFor(part.source.path) })
      out += placeholder
    }
  }
  return { text: out, changed: true }
}

export function inputTextFromContent(content, { attachments, nextId }) {
  if (!Array.isArray(content)) return String(content)
  let out = ''
  for (const part of content) {
    if (part.type === 'text') {
      out += part.text
    } else if (part.type === 'image' && part.source?.path) {
      const placeholder = `[Image #${nextId()}]`
      attachments.set(placeholder, { path: part.source.path, mediaType: part.source.mediaType || mediaTypeFor(part.source.path) })
      out += placeholder
    } else if (part.type === 'file' && part.path) {
      const placeholder = `[File #${nextId()}]`
      attachments.set(placeholder, { path: part.path, kind: 'file' })
      out += placeholder
    } else if (part.type === 'element' && part.selector) {
      const placeholder = `[File #${nextId()}]`
      attachments.set(placeholder, { url: part.url, selector: part.selector, tag: part.tag, text: part.text, html: part.html, rect: part.rect, component: part.component ?? null, kind: 'element' })
      out += placeholder
    } else if (part.type === 'commit' && part.hash) {
      const placeholder = `[File #${nextId()}]`
      attachments.set(placeholder, { hash: part.hash, subject: part.subject, root: part.root, kind: 'commit' })
      out += placeholder
    } else if (part.type === 'selection' && part.path) {
      const placeholder = `[File #${nextId()}]`
      attachments.set(placeholder, { path: part.path, text: part.text, fromLine: part.fromLine, toLine: part.toLine, ...(Number.isInteger(part.fromColumn) ? { fromColumn: part.fromColumn } : {}), ...(Number.isInteger(part.toColumn) ? { toColumn: part.toColumn } : {}), kind: 'selection' })
      out += placeholder
    } else {
      out += '[image]'
    }
  }
  return out
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

// images ride into a session by path, and the path is what the log keeps,
// so each one is copied into the session's own attachments directory
// before the message is written and the part points at the copy. later
// turns and later readers then never depend on the original still being
// where it was
async function stashImage(part, dir) {
  const path = part.source?.path
  if (!path || part.source.kind !== 'path' || path.startsWith(dir)) return part
  try {
    const { size, mtimeMs } = await stat(path)
    const key = createHash('sha1').update(`${path}\n${size}\n${Math.floor(mtimeMs)}`).digest('hex').slice(0, 10)
    const copy = join(dir, `${key}-${basename(path)}`)
    await mkdir(dir, { recursive: true })
    if (!existsSync(copy)) await copyFile(path, copy)
    return { ...part, source: { ...part.source, path: copy } }
  } catch {
    return part
  }
}

export async function stashImages(content, dir) {
  if (!Array.isArray(content)) return content
  return Promise.all(content.map((part) => (part.type === 'image' ? stashImage(part, dir) : part)))
}
