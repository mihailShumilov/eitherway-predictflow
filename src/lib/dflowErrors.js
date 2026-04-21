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

  const haystack = (body + ' ' + (json?.error || '') + ' ' + (json?.message || '') + ' ' + (json?.code || '')).toLowerCase()
  const upstreamMsg = (json?.message || json?.error || '').toString().trim()

  const kycHit = KYC_KEYWORDS.some(k => haystack.includes(k))
  const complianceHit = COMPLIANCE_KEYWORDS.some(k => haystack.includes(k))

  if (status === 401 || status === 403 || kycHit) {
    return pick('kyc', status, upstreamMsg || 'Identity verification required to trade.')
  }
  if (status === 451 || complianceHit) {
    return pick('compliance', status, upstreamMsg || 'Trading is not available in your region.')
  }
  return pick('other', status, upstreamMsg || `Order API ${status}`)
}

export function isGateRejection(classification) {
  return classification?.kind === 'kyc' || classification?.kind === 'compliance'
}
