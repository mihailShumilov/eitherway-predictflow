// Cloudflare Pages Function — same-origin Solana RPC proxy.
//
// Forwards POST bodies to HELIUS_RPC_URL (or SOLANA_RPC_URL fallback) so:
//   • The api-key never enters the browser bundle.
//   • The upstream's Origin/domain allowlist sees a server-side request
//     with no Origin header (instead of the user's domain), bypassing
//     allowlist mismatches.
//
// This is a blind JSON-RPC relay — anyone who finds the URL can issue
// arbitrary RPCs against your provider account. Mitigations:
//   • Same-origin only (CSP + browser SOP).
//   • Cloudflare's edge rate-limiting (configure in the dashboard if traffic warrants).
//   • Provider-side billing alerts.
// Tighten with a method allowlist if abuse becomes a real concern.

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const target = env.HELIUS_RPC_URL || env.SOLANA_RPC_URL
  if (!target) {
    return json({ error: 'HELIUS_RPC_URL not set on this Pages environment' }, 500)
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request.body,
    })
  } catch (err) {
    return json({ error: 'upstream failed', detail: String(err?.message || err) }, 502)
  }

  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new Response(upstream.body, { status: upstream.status, headers })
}

function json(b, status) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
