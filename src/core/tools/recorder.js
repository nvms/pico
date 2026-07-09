export function defaultTitle(name, args = {}) {
  const candidate = args.path || args.command || args.pattern || args.url || args.name
  if (typeof candidate === 'string' && candidate) return candidate
  const raw = JSON.stringify(args)
  if (!raw || raw === '{}') return name
  return raw.length > 60 ? raw.slice(0, 60) + '…' : raw
}

export function createRecorder() {
  return {
    currentCall: null,
    entries: [],
    pending: null,
    begin(name, args) {
      this.pending = {
        callId: this.currentCall?.id ?? null,
        name,
        title: defaultTitle(name, args),
        status: 'done',
        startedAt: Date.now(),
      }
    },
    extra(fields) {
      if (this.pending) Object.assign(this.pending, fields)
    },
    done(fields = {}) {
      if (!this.pending) return
      Object.assign(this.pending, fields, {
        durationMs: Date.now() - this.pending.startedAt,
      })
      delete this.pending.startedAt
      if (this.pending.fullOutput?.length > 200000) {
        this.pending.fullOutput = this.pending.fullOutput.slice(0, 200000) + '\n[truncated]'
      }
      this.entries.push(this.pending)
      this.pending = null
    },
  }
}

export function recorded(recorder, name, fn) {
  return async (args) => {
    recorder.begin(name, args)
    try {
      const result = await fn(args)
      if (!recorder.pending?.fullOutput && result !== undefined) {
        recorder.extra({
          fullOutput: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        })
      }
      recorder.done()
      return result
    } catch (err) {
      recorder.done({ status: 'error', error: String(err.message || err) })
      throw err
    }
  }
}
