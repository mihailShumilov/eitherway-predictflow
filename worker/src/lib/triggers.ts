// Pure trigger comparator. All prices in 0..1.
//
// Mirrors the legacy frontend `lib/triggers.js` but in TypeScript and
// owned by the keeper backend. The frontend's copy stays for the bridge
// period; remove it in Phase 5.

export type ConditionalOrderType = 'limit' | 'stop-loss' | 'take-profit'
export type Side = 'yes' | 'no'

export type TriggerCheck = {
  orderType: ConditionalOrderType
  triggerPrice: number
  status: string
}

export function shouldTriggerOrder(order: TriggerCheck, currentSidePrice: number): boolean {
  if (order == null || currentSidePrice == null) return false
  if (order.status !== 'pending' && order.status !== 'armed') return false
  switch (order.orderType) {
    case 'limit':
    case 'stop-loss':
      return currentSidePrice <= order.triggerPrice
    case 'take-profit':
      return currentSidePrice >= order.triggerPrice
    default:
      return false
  }
}

export type Prices = {
  yesAsk: number | null
  yesBid: number | null
  noAsk: number | null
  noBid: number | null
}

// Convert a DFlow `prices` channel message to the bid/ask quad. We need
// both sides because limit orders execute against asks (you pay the ask
// to buy) but stop-loss / take-profit are sells and execute against
// bids (you receive the bid when you sell). Reading the wrong side
// can fire a sell trigger 5–20 bps off in a wide-spread market.
export function pricesFromMessage(msg: {
  yes_ask?: string | null
  yes_bid?: string | null
  no_ask?: string | null
  no_bid?: string | null
}): Prices | null {
  const parse = (v: string | null | undefined) => {
    if (v == null) return null
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  const out: Prices = {
    yesAsk: parse(msg.yes_ask),
    yesBid: parse(msg.yes_bid),
    noAsk: parse(msg.no_ask),
    noBid: parse(msg.no_bid),
  }
  // Fill in implied sides from the inverse where the book is one-sided.
  // YES bid = 1 - NO ask, YES ask = 1 - NO bid (and symmetrically).
  if (out.yesAsk == null && out.noBid != null) out.yesAsk = 1 - out.noBid
  if (out.yesBid == null && out.noAsk != null) out.yesBid = 1 - out.noAsk
  if (out.noAsk == null && out.yesBid != null) out.noAsk = 1 - out.yesBid
  if (out.noBid == null && out.yesAsk != null) out.noBid = 1 - out.yesAsk

  if (out.yesAsk == null && out.yesBid == null && out.noAsk == null && out.noBid == null) return null
  return out
}

// Pick the relevant price for a (side, orderType) pair:
//   - limit BUY    → ASK of that side (price you'd pay).
//   - stop-loss    → BID of that side (price you'd receive when selling).
//   - take-profit  → BID of that side (price you'd receive when selling).
//
// Returns null if the relevant side of the book is empty — caller
// should skip evaluation rather than synthesize a price.
export function priceForOrder(prices: Prices, side: Side, orderType: ConditionalOrderType): number | null {
  if (orderType === 'limit') {
    return side === 'yes' ? prices.yesAsk : prices.noAsk
  }
  // stop-loss + take-profit are sells from the user's existing position.
  return side === 'yes' ? prices.yesBid : prices.noBid
}
