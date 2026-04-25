// Cloudflare Pages Function — KYC status check that delegates to DFlow.
//
// DFlow does not publish a per-wallet `/proof/status` endpoint, so we use
// /order itself as the source of truth: build (but never sign) a tiny canary
// order with the user's wallet, then classify the response. A 200 means
// DFlow is willing to route a trade for this wallet → verified. A 401/403
// or KYC/compliance-keyword body → not verified.
//
// Request:  POST { "wallet": "<base58 pubkey>" }
// Response: 200 { "verified": true }
//           200 { "verified": false, "reason": "..." }
//           502 { "verified": false, "reason": "...", "transient": true }
//
// The canary outcome mint is discovered from /api/v1/markets and cached at
// the edge for one hour. The wallet is never logged.
//
// Configure in the Cloudflare Pages dashboard:
//   DFLOW_UPSTREAM         (e.g. https://prediction-markets-api.dflow.net)
//   DFLOW_ORDER_UPSTREAM   (e.g. https://quote-api.dflow.net/order)
//   DFLOW_API_KEY          (secret)
//   DFLOW_API_KEY_HEADER   (optional, defaults to Authorization-Bearer)

const CANARY_CACHE_URL = 'https://predictflow.local/_cache/dflow-kyc-canary.v1.json'
const CANARY_CACHE_TTL = 3600
const PROBE_AMOUNT_LAMPORTS = 1_000_000
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const KYC_KEYWORDS = [
  'kyc', 'not verified', 'verify', 'verification',
  'identity', 'proof', 'unverified', 'kyc required',
]
const COMPLIANCE_KEYWORDS = [
  'jurisdiction', 'region', 'restricted', 'ineligible',
  'geo', 'geoblock', 'blocked', 'country', 'not eligible',
]

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let body
  try { body = await request.json() } catch { body = {} }
  const wallet = typeof body?.wallet === 'string' ? body.wallet.trim() : ''
  if (!isPlausibleSolanaAddress(wallet)) {
    return json({ verified: false, reason: 'wallet missing or malformed' }, 400)
  }

  if (!env.DFLOW_ORDER_UPSTREAM || !env.DFLOW_UPSTREAM) {
    return json({ verified: false, reason: 'KYC check not configured', transient: true }, 502)
  }

  const canary = await getCanaryMint(env)
  if (!canary) {
    return json({ verified: false, reason: 'no canary market available', transient: true }, 502)
  }

  const result = await probeOrder(env, wallet, canary)
  return json(result, result.transient ? 502 : 200)
}

function isPlausibleSolanaAddress(s) {
  return typeof s === 'string' && s.length >= 32 && s.length <= 64 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s)
}

async function getCanaryMint(env) {
  const cache = caches.default
  const hit = await cache.match(CANARY_CACHE_URL)
  if (hit) {
    try {
      const cached = await hit.json()
      if (cached?.mint) return cached.mint
    } catch { /* fall through */ }
  }

  const target = `${env.DFLOW_UPSTREAM.replace(/\/+$/, '')}/api/v1/markets?status=active&isInitialized=true&limit=20`
  let resp
  try {
    resp = await fetch(target, { headers: buildAuthHeaders(env), redirect: 'follow' })
  } catch { return null }
  if (!resp.ok) return null

  let payload
  try { payload = await resp.json() } catch { return null }

  const markets = Array.isArray(payload?.markets) ? payload.markets : (Array.isArray(payload) ? payload : [])
  const mint = pickFirstYesMint(markets)
  if (!mint) return null

  const cached = new Response(JSON.stringify({ mint }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CANARY_CACHE_TTL}, s-maxage=${CANARY_CACHE_TTL}`,
    },
  })
  await cache.put(CANARY_CACHE_URL, cached.clone())
  return mint
}

function pickFirstYesMint(markets) {
  for (const m of markets) {
    const accounts = m?.accounts || {}
    for (const acct of Object.values(accounts)) {
      if (acct?.isInitialized && typeof acct?.yesMint === 'string' && acct.yesMint.length >= 32) {
        return acct.yesMint
      }
    }
  }
  return null
}

async function probeOrder(env, wallet, outputMint) {
  const url = new URL(env.DFLOW_ORDER_UPSTREAM)
  url.searchParams.set('inputMint', USDC_MINT)
  url.searchParams.set('outputMint', outputMint)
  url.searchParams.set('amount', String(PROBE_AMOUNT_LAMPORTS))
  url.searchParams.set('userPublicKey', wallet)

  let resp
  try {
    resp = await fetch(url.toString(), { headers: buildAuthHeaders(env), redirect: 'follow' })
  } catch (err) {
    return { verified: false, reason: 'probe network error', transient: true }
  }

  if (resp.ok) return { verified: true }

  const classified = await classifyOrderResponse(resp)
  if (classified.kind === 'kyc' || classified.kind === 'compliance') {
    return { verified: false, reason: classified.message }
  }
  // 5xx / unrelated 4xx → don't flip a previously-verified user to unverified.
  return { verified: false, reason: classified.message, transient: true }
}

async function classifyOrderResponse(res) {
  const status = res.status
  let bodyText = ''
  let bodyJson = null
  try {
    bodyText = await res.clone().text()
    try { bodyJson = bodyText ? JSON.parse(bodyText) : null } catch { /* not JSON */ }
  } catch { /* already consumed */ }

  const haystack = (
    bodyText + ' ' +
    (bodyJson?.error || '') + ' ' +
    (bodyJson?.message || '') + ' ' +
    (bodyJson?.code || '')
  ).toLowerCase()
  const upstreamMsg = (bodyJson?.message || bodyJson?.error || '').toString().trim()

  const kycHit = KYC_KEYWORDS.some(k => haystack.includes(k))
  const complianceHit = COMPLIANCE_KEYWORDS.some(k => haystack.includes(k))

  if (status === 401 || status === 403 || kycHit) {
    return { kind: 'kyc', status, message: upstreamMsg || 'Identity verification required to trade.' }
  }
  if (status === 451 || complianceHit) {
    return { kind: 'compliance', status, message: upstreamMsg || 'Trading is not available in your region.' }
  }
  return { kind: 'other', status, message: upstreamMsg || `Order API ${status}` }
}

function buildAuthHeaders(env) {
  const apiKey = env.DFLOW_API_KEY
  if (!apiKey) return {}
  const headerName = env.DFLOW_API_KEY_HEADER || 'Authorization'
  const value = headerName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey
  return { [headerName]: value }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
