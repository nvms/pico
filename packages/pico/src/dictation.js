import { cleanDictation } from './dictation-text.js'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function dictationHelperPath() {
  const bundled = fileURLToPath(new URL('./pico-dictate', import.meta.url))
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../helper/.build/release/pico-dictate', import.meta.url))
}

export function createDictation({ onStatus = () => {}, onLevel = () => {}, onError = () => {}, platform = process.platform, arch = process.arch, launch = () => spawn(dictationHelperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] }), loadingTimeout = 600000, requestTimeout = 45000 } = {}) {
  let child = null
  let status = 'idle'
  let sequence = 0
  let generation = 0
  let ready = null
  const pending = new Map()

  function setStatus(value) {
    status = value
    onStatus(value)
  }

  function reset(error = new Error('dictation cancelled')) {
    const previous = child
    child = null
    ready = null
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    previous?.stdin.end()
    previous?.kill()
    setStatus('idle')
  }

  function waitFor(id, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reset(new Error('dictation timed out')), timeout)
      pending.set(id, { resolve, reject, timer })
    })
  }

  function settle(id, message) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error))
    else entry.resolve(message)
  }

  function load() {
    if (ready) return ready
    if (platform !== 'darwin' || arch !== 'arm64') throw new Error('dictation requires an Apple Silicon Mac')
    const instance = launch()
    child = instance
    ready = waitFor('ready', loadingTimeout)
    let buffer = ''
    instance.stdout.on('data', (chunk) => {
      if (child !== instance) return
      buffer += chunk.toString()
      if (buffer.length > 1024 * 1024) return reset(new Error('invalid dictation helper output'))
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.status === 'level') {
          if (status === 'recording' && Number.isFinite(message.level)) onLevel(Math.max(0, Math.min(1, message.level)))
        } else if (message.status === 'ready') settle('ready', message)
        else if (message.status === 'error') {
          const error = new Error(message.message || 'dictation failed')
          const active = pending.size > 0
          reset(error)
          if (!active) onError(error.message)
        } else if (message.id != null) settle(message.id, message)
      }
    })
    instance.stderr.on('data', () => {})
    const failed = (error) => {
      if (child !== instance) return
      const active = pending.size > 0
      const recording = status === 'recording'
      reset(error)
      if (!active && recording) onError(error.message)
    }
    instance.on('error', (error) => failed(new Error(`dictation helper unavailable: ${error.message}`)))
    instance.stdin.on('error', failed)
    instance.on('exit', () => failed(new Error('dictation helper exited')))
    return ready
  }

  function request(op) {
    const id = ++sequence
    const result = waitFor(id, requestTimeout)
    try { child.stdin.write(`${JSON.stringify({ id, op })}\n`) } catch (error) { reset(error) }
    return result
  }

  async function start() {
    if (status !== 'idle') return
    const token = ++generation
    setStatus('loading')
    try {
      await load()
      if (token !== generation) return
      setStatus('starting')
      await request('start')
      if (token === generation) setStatus('recording')
    } catch (error) {
      if (token !== generation) return
      reset(error)
      onError(error.message)
    }
  }

  async function stop() {
    if (status !== 'recording') return null
    const token = generation
    setStatus('transcribing')
    try {
      const result = await request('stop')
      if (token !== generation) return null
      setStatus('idle')
      return cleanDictation(result.text || '')
    } catch (error) {
      if (token === generation) {
        reset(error)
        onError(error.message)
      }
      return null
    }
  }

  async function cancel() {
    const token = ++generation
    if (status === 'idle') return
    if (status !== 'recording') return reset()
    setStatus('cancelling')
    try {
      await request('cancel')
      if (token === generation) setStatus('idle')
    } catch (error) {
      if (token === generation) reset(error)
    }
  }

  function dispose() {
    ++generation
    reset()
  }

  return { start, stop, cancel, dispose, get status() { return status } }
}
