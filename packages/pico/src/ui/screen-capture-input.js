export function createScreenCaptureInput({ captureRegion, getDraft, attachImage, setInput, onError, onStatus = () => {} }) {
  let pending = false
  return async function captureImage() {
    if (pending) return
    pending = true
    onStatus('capturing')
    const target = getDraft()
    try {
      const image = await captureRegion()
      if (!image) return
      const current = getDraft()
      if (current.revision !== target.revision || current.session !== target.session || current.value !== target.value || current.cursor !== target.cursor) {
        await image.dispose()
        onError('Screen capture not attached: the draft changed')
        return
      }
      const label = attachImage(image.path)
      if (!label) {
        await image.dispose()
        throw new Error('image attachment failed')
      }
      const before = target.value.slice(0, target.cursor)
      const after = target.value.slice(target.cursor)
      setInput(before + label + after, before.length + label.length)
    } catch (error) {
      onError(`Screen capture failed: ${error.message}`)
    } finally {
      pending = false
      onStatus('idle')
    }
  }
}
