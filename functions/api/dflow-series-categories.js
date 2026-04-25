// Cloudflare Pages Function — slim ticker→category lookup distilled from
// upstream /api/v1/series (~11MB). DFlow events don't carry category metadata,
// only seriesTicker, so the sidebar joins through this map. Cached at the
// edge so the heavy upstream fetch happens at most once per hour per POP.

// Version the cache key so shape-breaking changes invalidate cleanly across
// PoPs without waiting for the TTL. Bump when the response shape changes.
const CACHE_VERSION = 'v2'
const CACHE_URL = `https://predictflow.local/_cache/dflow-series-categories.${CACHE_VERSION}.json`
const CACHE_TTL = 3600

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const upstream = env.DFLOW_UPSTREAM
  if (!upstream) {
    return json({ error: 'DFLOW_UPSTREAM not set' }, 500)
  }

  const cache = caches.default
  const hit = await cache.match(CACHE_URL)
  if (hit) return hit

  const target = `${upstream.replace(/\/+$/, '')}/api/v1/series`
  const headers = new Headers()
  const apiKey = env.DFLOW_API_KEY
  if (apiKey) {
    const headerName = env.DFLOW_API_KEY_HEADER || 'Authorization'
    headers.set(
      headerName,
      headerName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey,
    )
  }

  let upstreamResp
  try {
    upstreamResp = await fetch(target, { headers, redirect: 'follow' })
  } catch (err) {
    return json({ error: 'upstream fetch failed', detail: String(err?.message || err) }, 502)
  }
  if (!upstreamResp.ok) {
    return json({ error: 'upstream non-ok', status: upstreamResp.status }, 502)
  }

  let body
  try {
    body = await upstreamResp.json()
  } catch {
    return json({ error: 'upstream parse failed' }, 502)
  }

  // Compact shape: { TICKER: ["Category", "tag1", "tag2", ...] }. The first
  // entry is the category; remaining entries are tags (used for subcategory
  // filtering). Empty-tag series collapse to a single-element array.
  const series = Array.isArray(body) ? body : body?.series || []
  const lookup = {}
  for (const s of series) {
    if (!s?.ticker || !s?.category) continue
    const tags = Array.isArray(s.tags) ? s.tags : []
    lookup[s.ticker] = [s.category, ...tags]
  }

  const out = new Response(JSON.stringify(lookup), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
    },
  })
  await cache.put(CACHE_URL, out.clone())
  return out
}

function json(b, status) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
