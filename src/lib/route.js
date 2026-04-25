// Hash-based router: keeps URLs shareable without server-side rewrite rules
// (works on any static host, including Cloudflare Pages, with no extra config).
//
// Supported shapes:
//   ""                            → { page: 'explore' }
//   "#/"                          → { page: 'explore' }
//   "#/portfolio"                 → { page: 'portfolio' }
//   "#/market/<ticker>"           → { page: 'explore', marketTicker }
//   "#/market/<ticker>?side=yes"  → { ..., side: 'yes' }

const VALID_PAGES = new Set(['explore', 'portfolio'])
const VALID_SIDES = new Set(['yes', 'no'])

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '').replace(/^\/+/, '')
  if (!raw) return { page: 'explore' }

  const [path, queryStr = ''] = raw.split('?')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(queryStr)

  if (segments[0] === 'market' && segments[1]) {
    const route = { page: 'explore', marketTicker: decodeURIComponent(segments[1]) }
    const side = params.get('side')
    if (VALID_SIDES.has(side)) route.side = side
    return route
  }

  if (segments[0] && VALID_PAGES.has(segments[0])) {
    return { page: segments[0] }
  }

  return { page: 'explore' }
}

export function formatHash({ page = 'explore', marketTicker, side } = {}) {
  if (marketTicker) {
    const params = new URLSearchParams()
    if (VALID_SIDES.has(side)) params.set('side', side)
    const qs = params.toString()
    return `#/market/${encodeURIComponent(marketTicker)}${qs ? `?${qs}` : ''}`
  }
  if (VALID_PAGES.has(page) && page !== 'explore') return `#/${page}`
  return '#/'
}
