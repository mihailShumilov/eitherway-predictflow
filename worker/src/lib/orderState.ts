import type { Env } from '../env'
import { audit } from './audit'
import { capturePh } from './posthog'
import type { FailureCode } from './failureReason'

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
