export function createRecorder() {
  return {
    currentCall: null,
    entries: [],
    pending: null,
    begin(name) {
      this.pending = {
        callId: this.currentCall?.id ?? null,
        name,
        title: name,
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
    recorder.begin(name)
    try {
      const result = await fn(args)
      recorder.done()
      return result
    } catch (err) {
      recorder.done({ status: 'error', error: String(err.message || err) })
      throw err
    }
  }
}
