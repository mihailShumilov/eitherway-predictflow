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

// Parse a book level (yesBid/yesAsk/noBid/noAsk) without inventing a
// fallback. DFlow ships `null` for empty sides of the book, and that
// signal must be preserved end-to-end — replacing null with 0.5 (the
// midpoint) makes a one-sided market look fully tradeable, which is
// exactly how route_not_found rejections surface late in the flow.
// Returns a finite number, or null if the input is missing/non-numeric.
export function parseLevel(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

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
// active (not finalized/settled/closed), the close time is in the future,
// and DFlow has published outcome mints (without them, useTradeSubmit /
// TradePanel can't actually route an order). DFlow ships
// `status: "finalized"` for resolved/expired markets even when the timestamp
// window says otherwise — so always trust status when present.
//
// We also require at least one published price level. A market with all
// four book levels (yesBid/yesAsk/noBid/noAsk) null is effectively dead —
// nothing to fill against on either side. This catches markets like
// post-resolution awaiting-settlement state where DFlow's aggregator
// returns `route_not_found` for any /order request. Note that ANY
// non-null level keeps the market tradeable: yesBid alone makes NO
// buyable (since yesBid + noAsk = 1), so partial liquidity is fine.
export function isMarketTradeable(market) {
  if (!market) return false
  const status = (market.status || '').toLowerCase()
  if (status && status !== 'active') return false
  const closeMs = market.closeTime ? new Date(market.closeTime).getTime() : NaN
  if (Number.isFinite(closeMs) && closeMs <= Date.now()) return false
  if (!market.yesMint || !market.noMint) return false
  const hasAnyLevel = [market.yesBid, market.yesAsk, market.noBid, market.noAsk]
    .some((v) => v !== null && v !== undefined && v !== '')
  if (!hasAnyLevel) return false
  return true
}

// Per-side liquidity check. A BUY needs an ask (or a derived ask via
// the inverse side's bid: yesAsk ≈ 1 − noBid, noAsk ≈ 1 − yesBid).
// Used by the trade panel to disable the BUY button before submission
// rather than letting DFlow return route_not_found.
export function canBuySide(market, side) {
  if (!market || (side !== 'yes' && side !== 'no')) return false
  if (side === 'yes') {
    return market.yesAsk != null && market.yesAsk !== ''
      || market.noBid != null && market.noBid !== ''
  }
  return market.noAsk != null && market.noAsk !== ''
    || market.yesBid != null && market.yesBid !== ''
}

// Settlement statuses that mean trading is over and the outcome is (or will
// soon be) decided. `determined` and `finalized` are the canonical resolved
// states from the DFlow lifecycle; `closed`/`settled`/`resolved` are seen on
// older payloads or alternate phrasings.
const SETTLED_STATUSES = new Set(['determined', 'finalized', 'closed', 'settled', 'resolved'])

// Infer which side won a settled market.
// Preference order: explicit field on the market payload, then book-price
// inference (a finalized outcome token's ask snaps to ~1.0 for the winner
// and ~0.0 for the loser). Returns 'yes' | 'no' | null (null means
// resolved-but-undetermined: voided market, or prices not yet snapped).
function inferWonSide(m, yesAsk, noAsk) {
  const explicit = (m.result ?? m.outcome ?? m.determinedOutcome ?? m.winningOutcome ?? m.winner ?? '')
    .toString().toLowerCase()
  if (explicit === 'yes') return 'yes'
  if (explicit === 'no') return 'no'
  // Voided / refunded markets — treat as no winner so we don't mislabel.
  if (explicit === 'void' || explicit === 'voided' || explicit === 'cancelled' || explicit === 'canceled') {
    return null
  }
  const yes = Number.isFinite(yesAsk) ? yesAsk : null
  const no = Number.isFinite(noAsk) ? noAsk : null
  // Need at least one side to be near a fixed point. Use 0.1 / 0.9 thresholds:
  // generous enough to handle dust on the resting book, tight enough that an
  // active market with mid prices won't get classified.
  if (yes != null && yes >= 0.9) return 'yes'
  if (no != null && no >= 0.9) return 'no'
  if (yes != null && yes <= 0.1 && no != null && no >= 0.5) return 'no'
  if (no != null && no <= 0.1 && yes != null && yes >= 0.5) return 'yes'
  return null
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

  const status = (m.status || '').toString().toLowerCase()
  const settled = SETTLED_STATUSES.has(status)
  const wonSide = settled ? inferWonSide(m, yesAsk, noAsk) : null

  return {
    marketId: m.id || m.marketId || m.market_id || null,
    ticker: m.ticker || m.marketTicker || m.market_ticker || null,
    question: m.question || m.title || m.name || 'Market',
    eventTitle: event.title || event.name || m.eventTitle || '',
    category: m.category || event.category || 'Other',
    closeTime: toCloseTimeIso(m.closeTime ?? m.close_time ?? event.closeTime ?? event.close_time),
    side: side || 'yes',
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : 0.5,
    status: status || null,
    settled,
    wonSide,
    yesMint,
    noMint,
  }
}
