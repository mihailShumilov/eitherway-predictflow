// Hash-based router: keeps URLs shareable without server-side rewrite rules
// (works on any static host, including Cloudflare Pages, with no extra config).
//
// Supported shapes:
//   ""                                     → { page: 'explore' }
//   "#/"                                   → { page: 'explore' }
//   "#/portfolio"                          → { page: 'portfolio' }
//   "#/category/<name>"                    → { page: 'explore', category }
//   "#/category/<name>/<sub>"              → { ..., category, subcategory }
//   "#/market/<ticker>"                    → { page: 'explore', marketTicker }
//   "#/market/<ticker>?side=yes"           → { ..., side: 'yes' }

const VALID_PAGES = new Set(['explore', 'portfolio', 'pricing', 'admin-revenue'])
const VALID_SIDES = new Set(['yes', 'no'])

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '').replace(/^\/+/, '')
  if (!raw) return { page: 'explore' }

  const [path, queryStr = ''] = raw.split('?')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(queryStr)

  // /admin/revenue → admin-revenue page (kept hidden from main nav)
  if (segments[0] === 'admin' && segments[1] === 'revenue') {
    return { page: 'admin-revenue' }
  }

  if (segments[0] === 'market' && segments[1]) {
    const route = { page: 'explore', marketTicker: decodeURIComponent(segments[1]) }
    const side = params.get('side')
    if (VALID_SIDES.has(side)) route.side = side
    // Carry the originating filter so closing the market returns to it.
    const cat = params.get('cat')
    if (cat) route.category = cat
    const sub = params.get('sub')
    if (sub) route.subcategory = sub
    return route
  }

  if (segments[0] === 'category' && segments[1]) {
    const route = { page: 'explore', category: decodeURIComponent(segments[1]) }
    if (segments[2]) route.subcategory = decodeURIComponent(segments[2])
    return route
  }

  if (segments[0] && VALID_PAGES.has(segments[0])) {
    return { page: segments[0] }
  }

  return { page: 'explore' }
}

export function formatHash({ page = 'explore', marketTicker, side, category, subcategory } = {}) {
  if (marketTicker) {
    const params = new URLSearchParams()
    if (VALID_SIDES.has(side)) params.set('side', side)
    if (category && category !== 'All') params.set('cat', category)
    if (subcategory) params.set('sub', subcategory)
    const qs = params.toString()
    return `#/market/${encodeURIComponent(marketTicker)}${qs ? `?${qs}` : ''}`
  }
  if (category && category !== 'All') {
    const head = `#/category/${encodeURIComponent(category)}`
    return subcategory ? `${head}/${encodeURIComponent(subcategory)}` : head
  }
  if (page === 'admin-revenue') return '#/admin/revenue'
  if (VALID_PAGES.has(page) && page !== 'explore') return `#/${page}`
  return '#/'
}
