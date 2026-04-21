// Cloudflare Pages Function — reverse-proxies /api/dflow/* to DFLOW_UPSTREAM.
//
// Configure in the dashboard:
//   Workers & Pages → predictflow → Settings → Variables and Secrets
//     Production → DFLOW_UPSTREAM=https://prediction-markets-api.dflow.net
//     Preview    → DFLOW_UPSTREAM=https://dev-prediction-markets-api.dflow.net
//
// PredictFlow's REST reads are GET; mutating verbs are rejected so a
// compromised frontend bundle cannot turn this proxy into a blind relay.

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

export async function onRequest({ request, env, params }) {
  const upstream = env.DFLOW_UPSTREAM
  if (!upstream) {
    return json(
      { error: 'DFLOW_UPSTREAM env var is not set on this Pages environment' },
      500,
    )
  }

  const method = request.method.toUpperCase()
  if (!FORWARDED_METHODS.has(method)) {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const subpath = resolveSubpath(params?.path)
  const { search } = new URL(request.url)
  const target = `${upstream.replace(/\/+$/, '')}/${subpath}${search}`

  const forwardedHeaders = new Headers()
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower.startsWith('cf-')) continue
    forwardedHeaders.set(name, value)
  }

  let upstreamResp
  try {
    upstreamResp = await fetch(target, {
      method,
      headers: forwardedHeaders,
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

function resolveSubpath(raw) {
  if (Array.isArray(raw)) return raw.join('/')
  if (typeof raw === 'string') return raw.replace(/^\/+/, '')
  return ''
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
