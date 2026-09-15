export function createDictationInput({ dictation, getInput, setInput }) {
  let draft = null
  let generation = 0

  function start({ value, cursor }) {
    if (dictation.status !== 'idle') return
    draft = { value, cursor }
    ++generation
    void dictation.start()
  }

  async function stop() {
    const token = generation
    const target = draft
    const text = await dictation.stop()
    if (token !== generation || !target || text == null || getInput() !== target.value) return
    const before = target.value.slice(0, target.cursor)
    const lead = text && before && !/\s$/.test(before) && !/^\s/.test(text) ? ' ' : ''
    setInput(before + lead + text + target.value.slice(target.cursor))
    draft = null
  }

  function cancel() {
    ++generation
    draft = null
    void dictation.cancel()
  }

  function handle(event) {
    if (dictation.status === 'idle') return false
    if (event.key === 'escape' || (event.ctrl && event.key === 'c')) cancel()
    else if (event.key === 'return' && !event.shift && !event.meta && dictation.status === 'recording') void stop()
    return true
  }

  return { start, cancel, handle }
}
