export function createWakeupManager({ onFire = () => {}, onChange = () => {} } = {}) {
  const wakeups = new Map()
  let nextId = 1

  return {
    schedule(delaySeconds, note) {
      const seconds = Math.max(5, Math.round(delaySeconds))
      const id = String(nextId++)
      const scheduledAt = Date.now()
      const at = scheduledAt + seconds * 1000
      const timer = setTimeout(() => {
        wakeups.delete(id)
        onChange()
        onFire({ id, note, at })
      }, seconds * 1000)
      wakeups.set(id, { id, note, at, scheduledAt, timer })
      onChange()
      return { id, at, seconds }
    },
    cancel(id) {
      const wakeup = wakeups.get(String(id))
      if (!wakeup) throw new Error(`no pending wake-up with id ${id}`)
      clearTimeout(wakeup.timer)
      wakeups.delete(String(id))
      onChange()
      return { id: wakeup.id, cancelled: true }
    },
    list() {
      return [...wakeups.values()]
        .map(({ id, note, at, scheduledAt }) => ({ id, note, at, scheduledAt }))
        .sort((a, b) => a.at - b.at)
    },
    pending() {
      return wakeups.size
    },
    cancelAll() {
      for (const wakeup of wakeups.values()) clearTimeout(wakeup.timer)
      wakeups.clear()
    },
  }
}
