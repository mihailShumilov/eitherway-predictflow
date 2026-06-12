import type { Env } from '../env'
import { audit } from './audit'
import { capturePh } from './posthog'
import type { FailureCode } from './failureReason'

// Failure codes after which the legacy flow's durable nonce can no longer be
// trusted: either the tx landed and advanced the nonce (tx_error), or it never
// confirmed and the cached value is stale (confirmation_timeout). In both
// cases the user's pre-signed tx is dead, so we clear the cached nonce and
// force a fresh registration on the next placement.
const NONCE_INVALIDATING_CODES = new Set<FailureCode>(['tx_error', 'confirmation_timeout'])

// Centralized terminal-state writer. Persists the stable failure code,
// records the raw detail to the audit table, and emits an audit event.
// `rawDetail` is logged to console.error and stored in audit.detail (which
// is internal-only); only `code` lands in orders.failure_reason which is
// served back to the client.
export async function markOrderFailed(
  env: Env,
  row: { id: string; wallet: string; market_ticker?: string },
  code: FailureCode,
  flow: 'durable_nonce_legacy' | 'approval',
  rawDetail?: string,
): Promise<void> {
  const now = Date.now()
  await env.DB
    .prepare(`UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(code, now, row.id)
    .run()
  // Best-effort: drop the stale cached nonce so the next legacy placement
  // re-registers a fresh one rather than composing against a consumed value.
  if (flow === 'durable_nonce_legacy' && row.market_ticker && NONCE_INVALIDATING_CODES.has(code)) {
    try {
      await env.DB
        .prepare(`UPDATE durable_nonces SET current_nonce = '', updated_at = ? WHERE wallet = ? AND market_ticker = ?`)
        .bind(now, row.wallet, row.market_ticker)
        .run()
    } catch (err) {
      console.error('nonce_invalidate_failed', { id: row.id, error: String(err) })
    }
  }
  await audit(env, {
    wallet: row.wallet,
    orderId: row.id,
    event: 'order.failed',
    detail: { code, flow, raw: rawDetail ? rawDetail.slice(0, 500) : undefined },
  })
  if (rawDetail) {
    console.error('order_failed', {
      id: row.id, code, flow, marketTicker: row.market_ticker, raw: rawDetail.slice(0, 500),
    })
  }
  // Single point where PostHog learns about a fill failure — every code
  // path (legacy submitter, approval submitter, simulation gate, decryption
  // failures) eventually lands here.
  await capturePh(env, row.wallet, 'order_fill_failed', {
    order_id: row.id,
    market_ticker: row.market_ticker,
    failure_code: code,
    flow,
  })
}
