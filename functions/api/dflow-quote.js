// Cloudflare Pages Function — reverse-proxies /api/dflow-quote → DFLOW_QUOTE_UPSTREAM.
//
// Configure in the dashboard:
//   Workers & Pages → predictflow → Settings → Variables and Secrets
//     Production → DFLOW_QUOTE_UPSTREAM=https://quote-api.dflow.net/quote
//     Preview    → DFLOW_QUOTE_UPSTREAM=https://dev-quote-api.dflow.net/quote
//
// The browser hits this same-origin URL with a GET + query string; the
// shared helper appends the query, strips hop-by-hop headers, and adds
// the DFLOW_API_KEY auth header server-side (never in the bundle).

import { proxyDflow } from '../_lib/dflow-proxy.js'

export async function onRequest({ request, env }) {
  return proxyDflow({
    request,
    env,
    upstream: env.DFLOW_QUOTE_UPSTREAM,
  })
}
