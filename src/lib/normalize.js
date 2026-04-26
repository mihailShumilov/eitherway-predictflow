import { toCloseTimeIso } from './dateFormat'

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

// DFlow trade shape (live):
//   { tradeId, ticker, yesPriceDollars: "0.0600", noPriceDollars: "0.9400",
//     count, countFp: "17.20", takerSide: "yes"|"no", createdTime: <unix s> }
// Older/mock shapes used { time, price (0..1), amount, side: "buy"|"sell" }.
export function normalizeTrade(t, i = 0) {
  if (!t || typeof t !== 'object') return null
  const timeMs = toMs(t.createdTime ?? t.time ?? t.timestamp ?? t.t ?? t.createdAt) ?? Date.now()
  const timeIso = new Date(timeMs).toISOString()
  // Prefer the decimal string DFlow ships; fall back to integer cents (`price`,
  // `yesPrice`), or the raw 0..1 mock value (`price`, `p`).
  let price = parseFloat(t.yesPriceDollars ?? t.price ?? t.yesPrice ?? t.p)
  if (Number.isFinite(price) && price > 1) price = price / 100
  const amount = parseFloat(t.countFp ?? t.count ?? t.amount ?? t.size ?? t.qty ?? 0)
  if (!Number.isFinite(price) || !Number.isFinite(amount)) return null
  // takerSide is YES/NO (not buy/sell). YES taker = bullish on YES → BUY in
  // this YES-centric view; NO taker → SELL. Fall back to legacy side fields
  // for older payloads.
  const taker = (t.takerSide ?? '').toString().toLowerCase()
  let side
  if (taker === 'yes') side = 'buy'
  else if (taker === 'no') side = 'sell'
  else {
    const legacy = (t.side ?? t.direction ?? '').toString().toLowerCase()
    side = legacy === 'sell' || legacy === 'ask' ? 'sell' : 'buy'
  }
  return {
    id: t.tradeId || t.id || `trade-${timeIso}-${i}`,
    time: timeIso,
    side,
    price: Math.round(price * 1000) / 1000,
    amount: Math.floor(amount),
    total: Math.round(price * amount * 100) / 100,
  }
}

// DFlow nests outcome mints under `market.accounts[<collateralMint>]`, keyed
// by settlement collateral; mainnet USDC is the production default. Older /
// mock shapes still set top-level `yesMint`/`noMint`, so we probe that first.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export function extractOutcomeMints(m) {
  if (!m || typeof m !== 'object') return { yesMint: null, noMint: null }

  const flatYes = m.yesMint || m.yes_mint || m.yesTokenMint || m.yes_token_mint
  const flatNo = m.noMint || m.no_mint || m.noTokenMint || m.no_token_mint
  if (flatYes || flatNo) return { yesMint: flatYes || null, noMint: flatNo || null }

  const accounts = m.accounts && typeof m.accounts === 'object' ? m.accounts : null
  if (!accounts) return { yesMint: null, noMint: null }

  const usdc = accounts[USDC_MINT]
  if (usdc?.isInitialized && usdc.yesMint && usdc.noMint) {
    return { yesMint: usdc.yesMint, noMint: usdc.noMint }
  }
  for (const a of Object.values(accounts)) {
    if (a?.isInitialized && a.yesMint && a.noMint) {
      return { yesMint: a.yesMint, noMint: a.noMint }
    }
  }
  return { yesMint: null, noMint: null }
}

// A market is tradeable when it accepts new orders right now: status is
// active (not finalized/settled/closed) and the close time is in the future.
// DFlow ships `status: "finalized"` for resolved/expired markets even when
// the timestamp window says otherwise — so always trust status when present.
export function isMarketTradeable(market) {
  if (!market) return false
  const status = (market.status || '').toLowerCase()
  if (status && status !== 'active') return false
  const closeMs = market.closeTime ? new Date(market.closeTime).getTime() : NaN
  if (Number.isFinite(closeMs) && closeMs <= Date.now()) return false
  return true
}

// market/by-mint response normalizer.
// Callers pass `mint` so we can infer which outcome (yes/no) the user holds.
export function normalizeMarket(payload, mint) {
  if (!payload || typeof payload !== 'object') return null
  const m = payload.market || payload.data || payload
  const event = payload.event || m.event || {}

  const { yesMint, noMint } = extractOutcomeMints(m)
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
    closeTime: toCloseTimeIso(m.closeTime ?? m.close_time ?? event.closeTime ?? event.close_time),
    side: side || 'yes',
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : 0.5,
    yesMint,
    noMint,
  }
}
