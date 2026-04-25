// Cloudflare Pages Function — reverse-proxies /api/dflow-order → DFLOW_ORDER_UPSTREAM.
//
// Configure in the dashboard:
//   Workers & Pages → predictflow → Settings → Variables and Secrets
//     Production → DFLOW_ORDER_UPSTREAM=https://quote-api.dflow.net/order
//     Preview    → DFLOW_ORDER_UPSTREAM=https://dev-quote-api.dflow.net/order
//
// The browser hits this same-origin URL with a GET + query string and an
// X-Idempotency-Key header. The shared helper forwards that header through,
// adds the DFLOW_API_KEY auth header server-side, and strips Set-Cookie
// from the upstream response.

import { proxyDflow } from '../_lib/dflow-proxy.js'

export async function onRequest({ request, env }) {
  return proxyDflow({
    request,
    env,
    upstream: env.DFLOW_ORDER_UPSTREAM,
  })
}
