// Shared formatters to eliminate the scattered duplicates in MarketCard,
// MarketDetail, and elsewhere.

export function formatUsd(num) {
  if (num == null || !Number.isFinite(num)) return '—'
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`
  if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`
  if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`
  return `$${num.toFixed(0)}`
}

export function formatCompactNumber(num) {
  if (num == null || !Number.isFinite(num)) return '—'
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`
  if (num >= 1e3) return `${(num / 1e3).toFixed(0)}K`
  return `${num.toFixed(0)}`
}

export function priceToPercent(price) {
  if (price == null || !Number.isFinite(price)) return '—'
  return `${(price * 100).toFixed(0)}¢`
}

export function priceToPercentFine(price) {
  if (price == null || !Number.isFinite(price)) return '—'
  return `${(price * 100).toFixed(1)}¢`
}

export function shortAddress(addr, head = 4, tail = 4) {
  if (!addr || typeof addr !== 'string' || addr.length <= head + tail + 1) return addr || '—'
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

// DFlow outcome labels are sometimes raw numbers without units, e.g.
// "Above 85" for a Rotten Tomatoes score (should read as "Above 85%") or
// "70,000 to 74,999.99" for a Bitcoin price band (should read as
// "$70,000 to $74,999.99"). Use the parent question as context to pick a unit.
export function humanizeOutcomeLabel(label, context = '') {
  if (!label || typeof label !== 'string') return label || ''
  const ctx = String(context).toLowerCase()
  const isScore = /\b(score|rating|tomatoes|percentile|percent|%)\b/.test(ctx)
  const isPrice = /\b(price|usd|\$)\b/.test(ctx)

  // "Above 85", "Below 60", "Over 70.5", etc. — append % for score/rating ctx.
  if (isScore) {
    const m = label.match(/^(Above|Below|Over|Under|At least|At most)\s+(\d+(?:\.\d+)?)\s*$/i)
    if (m) return `${m[1]} ${m[2]}%`
  }

  // "70,000 to 74,999.99", "999.99 or below", "20,000 to 24,999.99" — prepend $.
  if (isPrice) {
    const numPattern = /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g
    if (numPattern.test(label)) {
      return label.replace(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\b/g, '$$$1')
    }
  }

  return label
}
