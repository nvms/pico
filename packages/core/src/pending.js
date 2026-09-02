// what happens to the messages waiting on a turn once it ends. images the
// model asked to view travel apart from the user's own text, so a view
// delivery is never folded into a user message
export function settlePending({ views = [], expedited = [], queued = [], afterTool = false, interrupted = false }) {
  if (interrupted && !afterTool) return { views: [], messages: [], queued: [], recall: [...expedited, ...queued] }
  if (afterTool) return { views, messages: expedited, queued, recall: [] }
  return { views, messages: [...expedited, ...queued], queued: [], recall: [] }
}
