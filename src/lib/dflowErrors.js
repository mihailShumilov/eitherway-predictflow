// Classify a non-ok DFlow /order response so the caller can decide whether
// to re-open the KYC modal, show a region block, or surface a generic error.
// DFlow's error schema isn't in the public docs, so the classifier reads the
// status code first and falls back to keyword sniffing on the body. Widen
// the keyword lists if prod traffic surfaces new shapes.

const KYC_KEYWORDS = [
  'kyc', 'not verified', 'verify', 'verification',
  'identity', 'proof', 'unverified', 'kyc required',
]

const COMPLIANCE_KEYWORDS = [
  'jurisdiction', 'region', 'restricted', 'ineligible',
  'geo', 'geoblock', 'blocked', 'country', 'not eligible',
]

// DFlow's aggregator returns this when no swap path exists between the
// requested mints — e.g. the prediction market's book is one-sided
// (no asks on the side the user is buying) or the outcome mint is not
// in any active venue. The HTTP status is usually 400 with a body of
// `{"msg":"Route not found","code":"route_not_found"}`. Mapping it to a
// dedicated kind lets the trade UI render a useful "no liquidity"
// message instead of leaking the raw upstream error.
const NO_ROUTE_CODES = ['route_not_found', 'no_route', 'no_swap_route']
const NO_ROUTE_KEYWORDS = ['route not found', 'no route', 'no swap route']

function pick(kind, status, message) {
  return { kind, status, message }
}

export async function classifyOrderResponse(res) {
  const status = res.status
  let body = ''
  let json = null
  try {
    const text = await res.clone().text()
    body = text || ''
    try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  } catch { /* already consumed */ }

  const haystack = (body + ' ' + (json?.error || '') + ' ' + (json?.message || '') + ' ' + (json?.msg || '') + ' ' + (json?.code || '')).toLowerCase()
  const upstreamMsg = (json?.message || json?.msg || json?.error || '').toString().trim()
  const upstreamCode = (json?.code || '').toString().toLowerCase()

  const kycHit = KYC_KEYWORDS.some(k => haystack.includes(k))
  const complianceHit = COMPLIANCE_KEYWORDS.some(k => haystack.includes(k))
  const noRouteHit = NO_ROUTE_CODES.includes(upstreamCode)
    || NO_ROUTE_KEYWORDS.some(k => haystack.includes(k))

  if (status === 401 || status === 403 || kycHit) {
    return pick('kyc', status, upstreamMsg || 'Identity verification required to trade.')
  }
  if (status === 451 || complianceHit) {
    return pick('compliance', status, upstreamMsg || 'Trading is not available in your region.')
  }
  if (noRouteHit) {
    return pick(
      'no_route',
      status,
      'No matching liquidity in this market right now. The book may be one-sided — try the other outcome, or wait for new orders.',
    )
  }
  return pick('other', status, upstreamMsg || `Order API ${status}`)
}

export function isGateRejection(classification) {
  return classification?.kind === 'kyc' || classification?.kind === 'compliance'
}
