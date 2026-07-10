import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDredge, createWebTools } from '../src/core/tools/web.js'

test('resolveDredge resolves config and env with env winning', () => {
  assert.equal(resolveDredge({}, {}), null)
  assert.deepEqual(resolveDredge({ dredge: { url: 'http://a/', apiKey: 'k1' } }, {}), { url: 'http://a', apiKey: 'k1' })
  const resolved = resolveDredge({ dredge: { url: 'http://a', apiKey: 'k1' } }, { DREDGE_URL: 'http://b', DREDGE_API_KEY: 'k2' })
  assert.deepEqual(resolved, { url: 'http://b', apiKey: 'k2' })
  assert.deepEqual(resolveDredge({}, { DREDGE_URL: 'http://c' }), { url: 'http://c', apiKey: null })
})

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

const recorder = { extra: () => {} }
const dredge = { url: 'http://dredge.test', apiKey: 'secret' }
const jsonResponse = (body) => ({ json: async () => body, status: 200 })

test('web_search shapes results and sends auth', async () => {
  const [search] = createWebTools({ dredge, recorder })
  let seen
  await withFetch(async (url, opts) => {
    seen = { url: String(url), auth: opts.headers.authorization }
    return jsonResponse({
      ok: true,
      results: [{ title: 'A', url: 'http://x', snippet: 's', source: 'mojeek', rank: 1 }],
    })
  }, async () => {
    const out = await search.execute({ q: 'models.dev api' })
    assert.deepEqual(out.results, [{ title: 'A', url: 'http://x', snippet: 's', source: 'mojeek' }])
  })
  assert.match(seen.url, /^http:\/\/dredge\.test\/search\?q=models\.dev\+api$/)
  assert.equal(seen.auth, 'Bearer secret')
})

test('web_search reports backend status when empty and throws on error envelope', async () => {
  const [search] = createWebTools({ dredge, recorder })
  await withFetch(async () => jsonResponse({ ok: true, results: [], backends: [{ name: 'mojeek', status: 'rate_limited' }] }), async () => {
    const out = await search.execute({ q: 'x' })
    assert.match(out.note, /mojeek: rate_limited/)
  })
  await withFetch(async () => jsonResponse({ ok: false, error: { message: 'boom' } }), async () => {
    await assert.rejects(() => search.execute({ q: 'x' }), /boom/)
  })
})

test('web_fetch returns markdown and threads the cursor', async () => {
  const [, fetchTool] = createWebTools({ dredge, recorder })
  let seen
  await withFetch(async (url) => {
    seen = String(url)
    return jsonResponse({
      ok: true,
      doc: {
        markdown: '# Doc',
        metadata: { title: 'Doc', final_url: 'http://x/final' },
        pagination: { next_cursor: 'MQ' },
      },
    })
  }, async () => {
    const out = await fetchTool.execute({ url: 'http://x', cursor: 'MA' })
    assert.equal(out.markdown, '# Doc')
    assert.equal(out.finalUrl, 'http://x/final')
    assert.equal(out.next_cursor, 'MQ')
  })
  assert.match(seen, /cursor=MA/)
})

test('web_fetch surfaces dredge error codes', async () => {
  const [, fetchTool] = createWebTools({ dredge, recorder })
  await withFetch(async () => jsonResponse({ ok: false, doc: null, error: { code: 'TIMEOUT', message: 'request timed out', retryable: true } }), async () => {
    await assert.rejects(() => fetchTool.execute({ url: 'http://x' }), /TIMEOUT: request timed out \(retryable\)/)
  })
})
