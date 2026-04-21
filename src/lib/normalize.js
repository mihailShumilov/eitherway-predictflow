// Payload normalizers for DFlow responses.
//
// DFlow's live endpoints aren't versioned and different paths have returned
// slightly different shapes over time (arrays of tuples vs objects, snake
// vs camel case, wrapped vs unwrapped). These helpers probe the common
// shapes and collapse them into a stable shape the UI can count on.
//
// Each helper returns either a normalized object or `null` when the input
// can't be interpreted. Callers should `.filter(Boolean)` after mapping.

function toMs(t) {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t
  if (t === null || t === undefined || t === '') return null
  const parsed = new Date(t).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeCandle(c) {
  if (!c || typeof c !== 'object') return null
  const time = toMs(c.time ?? c.timestamp ?? c.t ?? c.openTime)
  if (time === null) return null
  const open = parseFloat(c.open ?? c.o)
  const close = parseFloat(c.close ?? c.c)
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null
  return {
    time,
    open,
    high: parseFloat(c.high ?? c.h),
    low: parseFloat(c.low ?? c.l),
    close,
    volume: parseFloat(c.volume ?? c.v ?? 0),
  }
}

// Orderbook level can arrive as `{price, size}`-like or as a `[price, size]` tuple.
export function normalizeLevel(level) {
  if (!level) return null
  const price = parseFloat(level.price ?? level.p ?? level[0])
  const size = parseFloat(level.size ?? level.qty ?? level.quantity ?? level.amount ?? level[1])
  return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null
}

export function normalizeTrade(t, i = 0) {
  if (!t || typeof t !== 'object') return null
  const timeMs = toMs(t.time ?? t.timestamp ?? t.t ?? t.createdAt) ?? Date.now()
  const timeIso = new Date(timeMs).toISOString()
  const price = parseFloat(t.price ?? t.p ?? 0)
  const amount = parseFloat(t.amount ?? t.size ?? t.qty ?? 0)
  if (!Number.isFinite(price) || !Number.isFinite(amount)) return null
  const sideRaw = (t.side ?? t.direction ?? '').toString().toLowerCase()
  const side = sideRaw === 'sell' || sideRaw === 'ask' ? 'sell' : 'buy'
  return {
    id: t.id || `trade-${timeIso}-${i}`,
    time: timeIso,
    side,
    price: Math.round(price * 1000) / 1000,
    amount: Math.floor(amount),
    total: Math.round(price * amount * 100) / 100,
  }
}

// market/by-mint response normalizer.
// Callers pass `mint` so we can infer which outcome (yes/no) the user holds.
export function normalizeMarket(payload, mint) {
  if (!payload || typeof payload !== 'object') return null
  const m = payload.market || payload.data || payload
  const event = payload.event || m.event || {}

  const yesMint = m.yesMint || m.yes_mint || m.yesTokenMint || null
  const noMint = m.noMint || m.no_mint || m.noTokenMint || null
  let side = null
  if (yesMint && yesMint === mint) side = 'yes'
  else if (noMint && noMint === mint) side = 'no'
  else if (m.side) side = m.side.toLowerCase() === 'no' ? 'no' : 'yes'

  const yesAsk = parseFloat(m.yesAsk ?? m.yes_ask ?? m.yesPrice ?? 0.5)
  const noAsk = parseFloat(m.noAsk ?? m.no_ask ?? m.noPrice ?? 0.5)
  const currentPrice = side === 'no' ? noAsk : yesAsk

  return {
    marketId: m.id || m.marketId || m.market_id || null,
    ticker: m.ticker || m.marketTicker || m.market_ticker || null,
    question: m.question || m.title || m.name || 'Market',
    eventTitle: event.title || event.name || m.eventTitle || '',
    category: m.category || event.category || 'Other',
    closeTime: m.closeTime || m.close_time || event.closeTime || event.close_time || null,
    side: side || 'yes',
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : 0.5,
    yesMint,
    noMint,
  }
}
