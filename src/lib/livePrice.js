// Shared live-price fetch — used by the conditional-order trigger loop and the
// DCA scheduler. Returns a { yes, no, source } ASK pair for a market, or null
// when no price source is reachable (and simulated fills are disabled).
//
// Preference order, most-trusted first:
//   1. Explicit env override (LIVE_PRICE_URL).
//   2. Per-market orderbook — same source as the on-screen book, keyed by
//      ticker (works even when marketId is a synthesized fallback).
//   3. by-event live_data — the legacy path; works only when DFlow echoes
//      our ids/tickers back.
//   4. Simulated drift (dev only, gated on ALLOW_SIMULATED_FILLS).

import {
  DFLOW_PROXY_BASE as DFLOW_BASE,
  LIVE_PRICE_URL,
  ALLOW_SIMULATED_FILLS,
} from '../config/env'
import { fetchWithRetry } from './http'

// DFlow live_data payload shape isn't formally documented — probe a few common
// layouts. `keys` are candidate identifiers to match (marketId AND/OR
// marketTicker — the id is often a synthesized `live-mkt-XX-YY` fallback that
// DFlow's response would never echo back, while the ticker is what the rest of
// the app already uses against DFlow successfully).
export function parseLivePrice(payload, keys) {
  if (!payload) return null
  const candidates = [payload]
  if (Array.isArray(payload)) candidates.push(...payload)
  if (Array.isArray(payload.markets)) candidates.push(...payload.markets)
  if (Array.isArray(payload.data)) candidates.push(...payload.data)

  const pickYes = (c) => {
    const yes = parseFloat(c.yesAsk ?? c.yes_ask ?? c.yesPrice ?? c.yes_price ?? c.yes)
    return Number.isFinite(yes) ? yes : null
  }

  const wanted = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
  if (wanted.length) {
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue
      const ids = [c.id, c.marketId, c.market_id, c.ticker, c.marketTicker].filter(Boolean)
      if (ids.some(id => wanted.includes(id))) {
        const yes = pickYes(c)
        if (yes !== null) return { yes, no: 1 - yes }
      }
    }
    return null
  }

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const yes = pickYes(c)
    if (yes !== null) return { yes, no: 1 - yes }
  }
  return null
}

// Derive current YES/NO ask prices from the same orderbook endpoint OrderBook
// uses on screen. yes_bids = orders to buy YES; no_bids = orders to buy NO.
// Selling YES at price P is economically the same as buying NO at (1-P), so
// the best YES ask is `1 - max(no_bid)` (and symmetrically for noAsk).
export function deriveAsksFromBook(data) {
  const yesBidKeys = data?.yes_bids ? Object.keys(data.yes_bids).map(parseFloat).filter(Number.isFinite) : []
  const noBidKeys = data?.no_bids ? Object.keys(data.no_bids).map(parseFloat).filter(Number.isFinite) : []
  const maxYesBid = yesBidKeys.length ? Math.max(...yesBidKeys) : null
  const maxNoBid = noBidKeys.length ? Math.max(...noBidKeys) : null
  const yesAsk = maxNoBid !== null ? 1 - maxNoBid : null
  const noAsk = maxYesBid !== null ? 1 - maxYesBid : null
  if (yesAsk === null && noAsk === null) return null
  return {
    yes: yesAsk !== null ? yesAsk : (noAsk !== null ? 1 - noAsk : null),
    no: noAsk !== null ? noAsk : (yesAsk !== null ? 1 - yesAsk : null),
  }
}

export async function fetchLivePrice(order) {
  if (LIVE_PRICE_URL) {
    try {
      const url = LIVE_PRICE_URL.replace('{eventTicker}', encodeURIComponent(order.eventTicker || ''))
      const res = await fetchWithRetry(url, {}, { retries: 1, timeoutMs: 3000 })
      if (res.ok) {
        const data = await res.json()
        const parsed = parseLivePrice(data, [order.marketId, order.marketTicker])
        if (parsed) return { ...parsed, source: 'dflow' }
      }
    } catch { /* fall through */ }
  }

  const bookTicker = order.marketTicker || order.marketId
  if (bookTicker) {
    try {
      const res = await fetchWithRetry(
        `${DFLOW_BASE}/api/v1/orderbook/${encodeURIComponent(bookTicker)}`,
        {}, { retries: 1, timeoutMs: 3000 },
      )
      if (res.ok) {
        const data = await res.json()
        const parsed = deriveAsksFromBook(data)
        if (parsed) return { ...parsed, source: 'orderbook' }
      }
    } catch { /* fall through */ }
  }

  if (order.eventTicker) {
    try {
      const res = await fetchWithRetry(
        `${DFLOW_BASE}/api/v1/live_data/by-event/${encodeURIComponent(order.eventTicker)}`,
        {}, { retries: 1, timeoutMs: 3000 },
      )
      if (res.ok) {
        const data = await res.json()
        const parsed = parseLivePrice(data, [order.marketId, order.marketTicker])
        if (parsed) return { ...parsed, source: 'dflow' }
      }
    } catch { /* fall through */ }
  }

  if (!ALLOW_SIMULATED_FILLS) {
    // In prod, never invent prices. Return null so the caller skips this tick.
    return null
  }
  const base = order.currentPrice ?? 0.5
  const drift = (Math.random() - 0.5) * 0.04
  const price = Math.min(0.99, Math.max(0.01, base + drift))
  return { yes: price, no: 1 - price, source: 'simulated' }
}
