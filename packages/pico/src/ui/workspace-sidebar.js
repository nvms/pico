export function workspaceGroups(rows) {
  const groups = new Map()
  for (const row of rows) {
    if (!row.name?.trim()) continue
    if (!groups.has(row.cwd)) groups.set(row.cwd, [])
    groups.get(row.cwd).push(row)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([cwd, sessions]) => ({ cwd, sessions }))
}

export function workspaceSelection(rows, selected, previous = []) {
  if (rows.some((row) => row.id === selected)) return selected
  const index = Math.max(0, previous.findIndex((row) => row.id === selected))
  return rows[Math.min(index, rows.length - 1)]?.id ?? null
}

export function workspaceNavigate(rows, selected, event, height) {
  const index = Math.max(0, rows.findIndex((row) => row.id === selected))
  const half = Math.max(1, Math.floor(height / 6))
  let next
  if (event.ctrl && event.key === 'd') next = index + half
  else if (event.ctrl && event.key === 'u') next = index - half
  else if (event.ctrl || event.meta || event.alt) return undefined
  else if (event.key === 'j' || event.key === 'down') next = index + 1
  else if (event.key === 'k' || event.key === 'up') next = index - 1
  else if (event.key === 'g') next = 0
  else if (event.key === 'G') next = rows.length - 1
  else return undefined
  return rows[Math.max(0, Math.min(rows.length - 1, next))]?.id ?? null
}

export function workspaceDraftAttachments(text, attachments) {
  return [...text.matchAll(/\[(?:Image|File) #\d+\]/g)].filter(match => attachments.has(match[0])).length
}

export function emptyWorkspaceComposer({ text, attachments, dictation, capture, pending, history, completion, command, question, steer, queued, expedited }) {
  return text === '' && attachments === 0 && dictation === 'idle' && capture === 'idle' && !pending && history < 0 && !completion && !command && !question && !steer && queued === 0 && expedited === 0
}

export function workspaceAction(row) {
  return row?.status === 'busy' ? 'interrupt' : row?.status === 'idle' ? 'demote' : null
}
