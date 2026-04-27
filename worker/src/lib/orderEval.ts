// Pure, testable order-evaluation helpers extracted from priceWatcher.ts.
//
// The Durable Object owns the WebSocket lifecycle and alarm scheduling;
// these helpers own the D1-touching SQL paths (reaper, confirmation
// polling, trigger evaluation, CAS arming). Splitting them lets the SQL
// behavior be tested without instantiating the DO.

import type { Env } from '../env'
import { audit } from './audit'
import { incr } from './metrics'
import {
  shouldTriggerOrder,
  priceForOrder,
  type Prices,
  type ConditionalOrderType,
  type Side,
} from './triggers'
import { submitOrder, checkSubmittedOrder } from './submitter'
import { SUBMITTING_REAP_MS } from './constants'

export type PendingOrderRow = {
  id: string
  wallet: string
  market_ticker: string
  market_id: string | null
  side: Side
  order_type: ConditionalOrderType
  trigger_price: number
  status: string
}

// Reap rows whose SEND stalled (status='submitting' with NO
// fill_signature, older than SUBMITTING_REAP_MS). Rows that broadcast
// successfully stay in `submitting` regardless of age — confirmation
// polling drives them to filled/failed.
export async function reapStuckSubmissions(env: Env, marketTicker: string): Promise<number> {
  const cutoff = Date.now() - SUBMITTING_REAP_MS
  const reaped = await env.DB
    .prepare(
      `UPDATE orders
          SET status = 'armed', updated_at = ?
        WHERE market_ticker = ?
          AND status = 'submitting'
          AND fill_signature IS NULL
          AND updated_at < ?`,
    )
    .bind(Date.now(), marketTicker, cutoff)
    .run()
  const count = reaped.meta.changes
  if (count > 0) {
    await audit(env, {
      event: 'submit.reaped',
      detail: { marketTicker, count },
    })
  }
  return count
}

// Run a single-shot confirmation check on every row in `submitting` that
// has a signature. Each check updates the row to filled/failed if the
// chain has decided; otherwise it leaves the row alone for the next
// alarm tick.
export async function pollPendingConfirmations(env: Env, marketTicker: string): Promise<number> {
  const result = await env.DB
    .prepare(
      `SELECT id FROM orders
        WHERE market_ticker = ? AND status = 'submitting' AND fill_signature IS NOT NULL`,
    )
    .bind(marketTicker)
    .all<{ id: string }>()
  const rows = result.results ?? []
  for (const row of rows) {
    await checkSubmittedOrder(env, row.id)
  }
  return rows.length
}

// Pending or armed — orders eligible for trigger re-evaluation.
export async function fetchPendingOrders(env: Env, marketTicker: string): Promise<PendingOrderRow[]> {
  const result = await env.DB
    .prepare(
      `SELECT id, wallet, market_ticker, market_id, side, order_type,
              trigger_price, status
         FROM orders
        WHERE market_ticker = ? AND status IN ('pending','armed')`,
    )
    .bind(marketTicker)
    .all<PendingOrderRow>()
  return result.results ?? []
}

// Anything still "live" — the DO only spins down when this returns empty.
export async function fetchOpenOrders(env: Env, marketTicker: string): Promise<{ id: string }[]> {
  const result = await env.DB
    .prepare(
      `SELECT id FROM orders
        WHERE market_ticker = ? AND status IN ('pending','armed','submitting')`,
    )
    .bind(marketTicker)
    .all<{ id: string }>()
  return result.results ?? []
}

// CAS arming: only one DO instance evaluates a given market, but a
// crash-recovery scenario could re-evaluate the same order. The
// `status = 'pending'` predicate makes `armed → submitting → filled`
// a one-way ratchet within D1.
export async function armAndSubmit(env: Env, order: PendingOrderRow, sidePrice: number): Promise<void> {
  const now = Date.now()
  const upd = await env.DB
    .prepare(
      `UPDATE orders
          SET status = 'armed', triggered_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(now, now, order.id)
    .run()

  if (upd.meta.changes === 0) {
    // Already armed by a prior tick or another instance. Skip.
    return
  }

  await audit(env, {
    wallet: order.wallet,
    orderId: order.id,
    event: 'trigger.fired',
    detail: { sidePrice, triggerPrice: order.trigger_price },
  })
  await incr(env, 'trigger_fired', { marketTicker: order.market_ticker })

  // Hand off to the submitter — async, fire-and-forget. Errors are
  // captured inside `submitOrder` and reflected in the row's status.
  submitOrder(env, order.id).catch((err) => {
    console.error('submit_order_unhandled', { id: order.id, error: String(err) })
  })
}

// Evaluate every pending/armed order against the current price quad and
// arm the ones whose triggers have crossed.
export async function evaluateAll(
  env: Env,
  marketTicker: string,
  prices: Prices,
): Promise<void> {
  const orders = await fetchPendingOrders(env, marketTicker)
  for (const o of orders) {
    // Pick the right price for this order type — ASK for limit buys,
    // BID for stop-loss / take-profit sells. Skip when the relevant
    // side of the book is empty rather than fire on a synthesized
    // cross-side price.
    const sidePrice = priceForOrder(prices, o.side, o.order_type)
    if (sidePrice == null) continue
    if (shouldTriggerOrder({
      orderType: o.order_type,
      triggerPrice: o.trigger_price,
      status: o.status,
    }, sidePrice)) {
      await armAndSubmit(env, o, sidePrice)
    }
  }
}
