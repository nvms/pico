export function createClipboardInput({ readImage, getDraft, attachImage, setInput, onError }) {
  let pending = false
  return async function pasteImage() {
    if (pending) return
    pending = true
    const target = getDraft()
    try {
      const image = await readImage()
      if (!image) {
        onError('No image on the clipboard')
        return
      }
      const current = getDraft()
      if (current.revision !== target.revision || current.session !== target.session || current.value !== target.value || current.cursor !== target.cursor) {
        await image.dispose()
        onError('Clipboard image not attached: the draft changed')
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
      onError(`Clipboard paste failed: ${error.message}`)
    } finally {
      pending = false
    }
  }
}
