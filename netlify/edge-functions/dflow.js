// Netlify Edge Function: secure DFlow reverse proxy.
//
// Mirrors functions/_lib/dflow-proxy.js (Cloudflare Pages) and
// api/dflow/[...path].js (Vercel). Replaces the previous netlify.toml redirect
// that forwarded every method straight to DFlow with no key and no
// restriction. Only GET/HEAD/OPTIONS are forwarded, the API key is injected
// from server env (never reaches the browser), and hop-by-hop / cookie headers
// are stripped.
//
// Set DFLOW_API_KEY (and optionally DFLOW_API_KEY_HEADER, DFLOW_UPSTREAM) in
// the Netlify site environment.

const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'te', 'trailers', 'cookie',
])

export default async (request) => {
  const method = request.method.toUpperCase()
  if (!FORWARDED_METHODS.has(method)) {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Netlify Edge runs on Deno; env is exposed via the Netlify global.
  const readEnv = (k) => (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get(k)) || undefined
  const upstream = (readEnv('DFLOW_UPSTREAM') || 'https://dev-prediction-markets-api.dflow.net').replace(/\/+$/, '')
  const url = new URL(request.url)
  const subpath = url.pathname.replace(/^\/api\/dflow\/?/, '')
  const target = subpath ? `${upstream}/${subpath}${url.search}` : `${upstream}${url.search}`

  const headers = new Headers()
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower.startsWith('cf-') || lower.startsWith('x-nf-')) continue
    headers.set(name, value)
  }

  const apiKey = readEnv('DFLOW_API_KEY')
  if (apiKey) {
    const headerName = readEnv('DFLOW_API_KEY_HEADER') || 'Authorization'
    headers.set(headerName, headerName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey)
  }

  let upstreamResp
  try {
    upstreamResp = await fetch(target, { method, headers, redirect: 'follow' })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Upstream DFlow fetch failed', detail: String((err && err.message) || err) }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
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

export const config = { path: '/api/dflow/*' }
