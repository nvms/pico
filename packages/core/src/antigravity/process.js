// What an `agy acp` process runs with: Google's own Antigravity agent,
// unmodified, which signs in, keeps its login and talks to Google itself.
// pico never reads or passes on agy's credentials.

import { mkdtempSync, rmSync, writeFileSync, watch, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// these make agy use an API key or a Cloud project in place of the Google
// sign-in, silently; a session in pico always runs on the subscription
const API_AUTH_VARIABLES = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ADC_AUTH',
  'GOOGLE_GEMINI_BASE_URL',
]

export function agyEnv(env = process.env) {
  const out = { ...env }
  for (const key of API_AUTH_VARIABLES) delete out[key]
  return out
}

// the programs agy may open a web page with; stood in for while signing
// in, so the page is shown where the person is rather than on this machine
const OPENERS = ['xdg-open', 'open', 'sensible-browser', 'x-www-browser', 'gnome-open', 'kde-open', 'wslview']

// a folder of stand-in openers that write the page they were asked to open
// to a file, and a way to wait for it. agy runs them with their output
// thrown away, so the file is the only way the address comes back
export function pageCatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'pico-agy-open-'))
  const file = join(dir, 'opened')
  const script = `#!/bin/sh\nprintf '%s\\n' "$1" >> '${file}'\n`
  for (const opener of OPENERS) writeFileSync(join(dir, opener), script, { mode: 0o755 })
  let watcher = null
  return {
    env: (env) => ({ ...env, PATH: `${dir}${delimiter}${env.PATH ?? ''}`, BROWSER: join(dir, 'xdg-open') }),
    // the first page agy opens
    next() {
      return new Promise((resolve) => {
        const read = () => {
          if (!existsSync(file)) return false
          const url = readFileSync(file, 'utf8').split('\n').find(Boolean)
          if (url) { watcher?.close(); watcher = null; resolve(url.trim()) }
          return !!url
        }
        if (read()) return
        watcher = watch(dir, () => { read() })
      })
    },
    close() {
      watcher?.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// agy as pico runs it: an ACP agent, with no permission prompts, as pico
// runs; questions still come, and go to the person
export const AGY_ARGS = ['acp', '--dangerously-skip-permissions']
