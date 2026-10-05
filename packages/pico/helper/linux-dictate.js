#!/usr/bin/env node
import { spawn as nodeSpawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

export function wavHeader(bytes) {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(bytes, 40)
  return header
}

export async function findExecutable(name, env = process.env) {
  const paths = name.includes('/') ? [name] : (env.PATH || '').split(delimiter).map(dir => join(dir, name))
  for (const path of paths) {
    try { await fs.access(path, constants.X_OK); return path } catch {}
  }
  return null
}

export function createLinuxDictation({ emit = () => {}, spawn = nodeSpawn, env = process.env,
  executable = name => findExecutable(name, env), files = fs, tempRoot = tmpdir(),
  maxRecordingMs = 120000, killTimeoutMs = 1000 } = {}) {
  const model = env.PICO_WHISPER_MODEL || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pico/whisper/ggml-base.en.bin')
  let active = null
  let disposed = false
  const jobs = new Set()
  const send = message => { if (!disposed) emit(message) }

  function launch(binary, args) {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const job = { child, error: null, stderr: '', done: false }
    jobs.add(job)
    child.stderr?.on('data', chunk => { job.stderr = (job.stderr + chunk.toString()).slice(-4096) })
    job.closed = new Promise(resolve => {
      child.once('error', error => { job.error = error; finish(null) })
      child.once('close', code => finish(code))
      function finish(code) {
        if (job.done) return
        job.done = true; jobs.delete(job); resolve(code)
      }
    })
    job.started = new Promise((resolve, reject) => {
      child.once('spawn', resolve); child.once('error', reject)
    })
    // Transcription may be cancelled before anyone awaits startup.
    job.started.catch(() => {})
    return job
  }

  async function terminate(job) {
    if (!job || job.done) return
    job.child.kill('SIGTERM')
    const timer = setTimeout(() => { if (!job.done) job.child.kill('SIGKILL') }, killTimeoutMs)
    try { await job.closed } finally { clearTimeout(timer) }
  }

  async function cleanup(session) {
    if (!session) return
    session.cancelled = true
    clearTimeout(session.timer)
    await Promise.all([terminate(session.recorder), terminate(session.transcriber)])
    if (session.dir) await files.rm(session.dir, { recursive: true, force: true })
    if (active === session) active = null
  }

  async function start() {
    if (active) throw new Error('Dictation is already active.')
    const session = { chunks: [], bytes: 0, cancelled: false, stopping: false }
    active = session
    try {
      const whisper = env.PICO_WHISPER_BIN
        ? await executable(env.PICO_WHISPER_BIN)
        : await executable(join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pico/whisper/whisper-cli')) || await executable('whisper-cli')
      if (!whisper) throw new Error('Install whisper.cpp and put whisper-cli on PATH, or set PICO_WHISPER_BIN.')
      try { await files.access(model, constants.R_OK) } catch {
        throw new Error(`Whisper model not found or unreadable: ${model}. Install a whisper.cpp GGML model and set PICO_WHISPER_MODEL (no models are downloaded automatically).`)
      }
      const pw = await executable('pw-record')
      const recorder = pw || await executable('parec')
      if (!recorder) throw new Error('Install PipeWire (pw-record) or PulseAudio utilities (parec) for microphone recording.')
      if (session.cancelled) return
      session.whisper = whisper
      session.dir = await files.mkdtemp(join(tempRoot, 'pico-dictation-'))
      if (session.cancelled) { await cleanup(session); return }
      const args = pw ? ['--raw', '--format', 's16', '--rate', '16000', '--channels', '1'] : ['--raw', '--format=s16le', '--rate=16000', '--channels=1']
      if (env.PICO_DICTATION_SOURCE) args.push(pw ? '--target' : '--device', env.PICO_DICTATION_SOURCE)
      if (pw) args.push('-')
      const job = session.recorder = launch(recorder, args)
      let lastLevel = 0
      job.child.stdout.on('data', chunk => {
        if (session.cancelled || session.stopping) return
        const remaining = Math.floor(maxRecordingMs * 32) - session.bytes
        const data = Buffer.from(chunk.subarray(0, Math.max(0, remaining)))
        session.chunks.push(data); session.bytes += data.length
        if (Date.now() - lastLevel >= 50) {
          let sum = 0
          for (let i = 0; i + 1 < data.length; i += 2) sum += (data.readInt16LE(i) / 32768) ** 2
          send({ status: 'level', level: data.length >= 2 ? Math.sqrt(sum / Math.floor(data.length / 2)) : 0 })
          lastLevel = Date.now()
        }
        if (session.bytes >= Math.floor(maxRecordingMs * 32)) void limit()
      })
      const limit = async () => {
        if (session.cancelled || session.stopping) return
        session.stopping = true
        send({ status: 'error', message: 'Dictation reached the 120-second recording limit. Please record a shorter passage.' })
        await cleanup(session)
      }
      await job.started
      job.closed.then(async code => {
        if (session.cancelled || session.stopping) return
        send({ status: 'error', message: `Microphone recording stopped unexpectedly (${code ?? job.error?.message ?? 'unknown error'}). Check your audio source and permissions.${job.stderr ? ` ${job.stderr.trim()}` : ''}` })
        await cleanup(session)
      })
      session.timer = setTimeout(() => { void limit() }, maxRecordingMs)
    } catch (error) { await cleanup(session); throw error }
  }

  async function stop() {
    const session = active
    if (!session || !session.recorder || session.stopping) throw new Error('No active dictation recording.')
    session.stopping = true
    clearTimeout(session.timer)
    try {
      await terminate(session.recorder)
      if (session.cancelled) throw new Error('Dictation cancelled.')
      const pcm = Buffer.concat(session.chunks)
      const audio = join(session.dir, 'audio.wav')
      const prefix = join(session.dir, 'transcript')
      const even = pcm.subarray(0, pcm.length - pcm.length % 2)
      await files.writeFile(audio, Buffer.concat([wavHeader(even.length), even]), { mode: 0o600 })
      if (session.cancelled) throw new Error('Dictation cancelled.')
      const job = session.transcriber = launch(session.whisper, ['-m', model, '-f', audio, '-otxt', '-of', prefix, '-l', env.PICO_WHISPER_LANGUAGE || 'en', '-nt'])
      const code = await job.closed
      if (session.cancelled) throw new Error('Dictation cancelled.')
      if (job.error || code !== 0) throw new Error(`Whisper transcription failed: ${job.error?.message || job.stderr.trim() || `exit ${code}`}`)
      return (await files.readFile(`${prefix}.txt`, 'utf8')).trim()
    } finally { await cleanup(session) }
  }

  async function handle(command) {
    if (disposed) return
    const id = command?.id
    try {
      if (id == null) throw new Error('Command requires an id.')
      if (command.op === 'start') { await start(); send({ id }) }
      else if (command.op === 'stop') send({ id, text: await stop() })
      else if (command.op === 'cancel') { await cleanup(active); send({ id }) }
      else throw new Error('Unknown dictation command.')
    } catch (error) { send({ id, error: error.message }) }
  }

  async function dispose() {
    disposed = true
    await cleanup(active)
    await Promise.all([...jobs].map(terminate))
  }
  return { handle, dispose }
}

export function runLinuxDictation({ input = process.stdin, output = process.stdout, signals = process, ...options } = {}) {
  const emit = message => output.write(`${JSON.stringify(message)}\n`)
  const helper = createLinuxDictation({ ...options, emit })
  const lines = createInterface({ input })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    lines.close()
    signals.removeListener('SIGTERM', close); signals.removeListener('SIGINT', close)
    await helper.dispose()
  }
  lines.on('line', line => {
    if (line.length > 65536) return emit({ status: 'error', message: 'Dictation command is too large.' })
    try { void helper.handle(JSON.parse(line)) } catch { emit({ status: 'error', message: 'Invalid dictation command JSON.' }) }
  })
  lines.on('close', close)
  input.on('error', close)
  output.on('error', close)
  signals.on('SIGTERM', close); signals.on('SIGINT', close)
  emit({ status: 'ready' })
  return { ...helper, dispose: close }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLinuxDictation()
