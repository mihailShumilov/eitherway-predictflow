// Cloudflare Pages Function — reverse-proxies /api/dflow/* to DFLOW_UPSTREAM.
//
// Configure in the dashboard:
//   Workers & Pages → predictflow → Settings → Variables and Secrets
//     Production → DFLOW_UPSTREAM=https://prediction-markets-api.dflow.net
//     Production → DFLOW_API_KEY=<prod key>          (Secret)
//     Preview    → DFLOW_UPSTREAM=https://dev-prediction-markets-api.dflow.net
//     Preview    → DFLOW_API_KEY=<dev key, if any>   (Secret)
//
// The shared helper injects the API key server-side so it never lands in
// the browser bundle. Mutating verbs are rejected — see ../../_lib/dflow-proxy.js.

import { proxyDflow } from '../../_lib/dflow-proxy.js'

export async function onRequest({ request, env, params }) {
  return proxyDflow({
    request,
    env,
    upstream: env.DFLOW_UPSTREAM,
    subpath: resolveSubpath(params?.path),
  })
}

function resolveSubpath(raw) {
  if (Array.isArray(raw)) return raw.join('/')
  if (typeof raw === 'string') return raw.replace(/^\/+/, '')
  return ''
}
