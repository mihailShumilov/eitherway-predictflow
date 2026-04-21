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
