const DEFAULT_SLICE_CHARS = 24000
const MAX_SLICE_CHARS = 100000

export function resolveDredge(config = {}, env = process.env) {
  const url = env.DREDGE_URL || config.dredge?.url || null
  if (!url) return null
  return {
    url: url.replace(/\/+$/, ''),
    apiKey: env.DREDGE_API_KEY || config.dredge?.apiKey || null,
  }
}

async function call(dredge, path, params, signal) {
  const query = new URLSearchParams(params)
  const response = await fetch(`${dredge.url}${path}?${query}`, {
    signal,
    headers: dredge.apiKey ? { authorization: `Bearer ${dredge.apiKey}` } : {},
  })
  const body = await response.json().catch(() => null)
  if (!body) throw new Error(`dredge returned http ${response.status} with no usable body`)
  return body
}

export function createWebTools({ dredge, recorder, signal }) {
  return [
    {
      name: 'web_search',
      description:
        'Search the web. Google-style operators work: site:, filetype:pdf, quoted phrases. Returns ranked results; pass a result url to web_fetch to read it.',
      schema: {
        q: { type: 'string', description: 'the search query' },
      },
      execute: async ({ q }) => {
        recorder.extra({ title: q })
        const body = await call(dredge, '/search', { q }, signal)
        if (!body.ok) throw new Error(body.error?.message || 'search failed')
        const results = (body.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          source: r.source,
        }))
        if (results.length === 0) {
          const backends = (body.backends || []).map((b) => `${b.name}: ${b.status}`).join(', ')
          return { results, note: backends ? `no results · backends: ${backends}` : 'no results' }
        }
        return { results }
      },
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a url and read it as clean markdown (html, pdf, docx, and textual formats like json). Long documents arrive in slices: the result says which slice you have (e.g. "slice 1 of 12") and next_cursor continues from there. Every slice you fetch permanently occupies conversation context, so only walk cursors for content you actually need, and raise maxChars only when the task genuinely needs a bigger window.',
      schema: {
        url: { type: 'string', description: 'the url to fetch' },
        cursor: { type: 'string', description: 'pagination cursor from a previous web_fetch of the same url', optional: true },
        maxChars: { type: 'number', description: `slice size in characters, default ${DEFAULT_SLICE_CHARS}, max ${MAX_SLICE_CHARS}`, optional: true },
      },
      execute: async ({ url, cursor, maxChars }) => {
        recorder.extra({ title: url.replace(/^https?:\/\//, '').slice(0, 80) })
        const slice = Math.min(MAX_SLICE_CHARS, Math.max(1000, maxChars || DEFAULT_SLICE_CHARS))
        const body = await call(dredge, '/fetch', { url, maxChars: slice, ...(cursor && { cursor }) }, signal)
        if (!body.ok) {
          const { code, message, retryable } = body.error || {}
          throw new Error(`${code || 'fetch failed'}: ${message || url}${retryable ? ' (retryable)' : ''}`)
        }
        const { markdown, metadata, pagination } = body.doc
        return {
          markdown,
          title: metadata?.title || null,
          finalUrl: metadata?.final_url || url,
          ...(pagination?.total_chunks > 1 && { slice: `${pagination.chunk_index + 1} of ${pagination.total_chunks}` }),
          ...(pagination?.next_cursor && { next_cursor: pagination.next_cursor }),
        }
      },
    },
  ]
}
