// Shared reverse-proxy helper for the DFlow Cloudflare Pages Functions.
//
// Each `functions/api/dflow*` route hands us its upstream + (optional) API
// key from server-side env. We forward the request, strip headers that
// shouldn't traverse a reverse proxy, and inject the API key — so the key
// only ever exists on the edge runtime, never in the browser bundle.
//
// Auth header shape:
//   DFLOW_API_KEY=<token>                    →  Authorization: Bearer <token>
//   DFLOW_API_KEY=<token>
//     DFLOW_API_KEY_HEADER=x-api-key         →  x-api-key: <token>
// If DFlow ends up requiring something else, edit `buildAuthHeader` below.
//
// Only GET / HEAD / OPTIONS are forwarded — a compromised frontend bundle
// cannot turn this proxy into a blind relay for state-changing requests.

const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailers',
  'cookie',
])

export async function proxyDflow({ request, env, upstream, subpath = '' }) {
  if (!upstream) {
    return json(
      { error: 'DFlow upstream env var is not set on this Pages environment' },
      500,
    )
  }

  const method = request.method.toUpperCase()
  if (!FORWARDED_METHODS.has(method)) {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const { search } = new URL(request.url)
  const base = upstream.replace(/\/+$/, '')
  const cleanSub = typeof subpath === 'string' ? subpath.replace(/^\/+/, '') : ''
  const target = cleanSub ? `${base}/${cleanSub}${search}` : `${base}${search}`

  const headers = new Headers()
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower.startsWith('cf-')) continue
    headers.set(name, value)
  }

  const auth = buildAuthHeader(env)
  if (auth) headers.set(auth.name, auth.value)

  let upstreamResp
  try {
    upstreamResp = await fetch(target, {
      method,
      headers,
      redirect: 'follow',
    })
  } catch (err) {
    return json(
      {
        error: 'Upstream DFlow fetch failed',
        detail: String((err && err.message) || err),
      },
      502,
    )
  }

  const respHeaders = new Headers(upstreamResp.headers)
  respHeaders.delete('set-cookie')
  respHeaders.delete('server')

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  })
}

function buildAuthHeader(env) {
  const apiKey = env.DFLOW_API_KEY
  if (!apiKey) return null
  const headerName = env.DFLOW_API_KEY_HEADER || 'Authorization'
  const value = headerName.toLowerCase() === 'authorization'
    ? `Bearer ${apiKey}`
    : apiKey
  return { name: headerName, value }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
