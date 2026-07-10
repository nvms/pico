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
        'Fetch a url and read it as clean markdown (html, pdf, and docx all convert). Long documents arrive in slices: when the result has next_cursor, call web_fetch again with that cursor to read the next slice.',
      schema: {
        url: { type: 'string', description: 'the url to fetch' },
        cursor: { type: 'string', description: 'pagination cursor from a previous web_fetch of the same url', optional: true },
      },
      execute: async ({ url, cursor }) => {
        recorder.extra({ title: url.replace(/^https?:\/\//, '').slice(0, 80) })
        const body = await call(dredge, '/fetch', { url, ...(cursor && { cursor }) }, signal)
        if (!body.ok) {
          const { code, message, retryable } = body.error || {}
          throw new Error(`${code || 'fetch failed'}: ${message || url}${retryable ? ' (retryable)' : ''}`)
        }
        const { markdown, metadata, pagination } = body.doc
        return {
          markdown,
          title: metadata?.title || null,
          finalUrl: metadata?.final_url || url,
          ...(pagination?.next_cursor && { next_cursor: pagination.next_cursor }),
        }
      },
    },
  ]
}
