import { codeToANSI } from '@shikijs/cli'
import { createSignal } from '@trendr/core'

const LANGS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx',
  json: 'json', jsonl: 'json', md: 'md', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', java: 'java', css: 'css',
  html: 'html', vue: 'vue', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', svelte: 'svelte',
}

export function langForPath(path) {
  const ext = String(path).split('.').pop().toLowerCase()
  return LANGS[ext] || 'txt'
}

const cache = new Map()
const pending = new Set()
const failed = new Set()
const [version, setVersion] = createSignal(0)

export const highlightVersion = version

export function highlight(code, lang) {
  const safeLang = lang && !failed.has(lang) ? lang : 'txt'
  return code
    .split('\n')
    .map((line) => {
      const key = `${safeLang}\n${line}`
      if (cache.has(key)) return cache.get(key)
      warm(line, safeLang, key)
      return line
    })
    .join('\n')
}

function warm(line, lang, key) {
  if (pending.has(key)) return
  pending.add(key)
  codeToANSI(line, lang, 'nord')
    .then((ansi) => cache.set(key, ansi.replace(/\n$/, '')))
    .catch(() => {
      failed.add(lang)
      cache.set(key, line)
    })
    .finally(() => {
      pending.delete(key)
      setVersion((v) => v + 1)
    })
}
