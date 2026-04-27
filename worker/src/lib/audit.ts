// Append-only audit log. Best-effort: a failed audit insert must not block
// the user request. We log to console.error on failure so the operator
// notices via Worker logs, but the request still succeeds.

import type { Env } from '../env'

export type AuditEvent = {
  wallet?: string | null
  orderId?: string | null
  event: string
  detail?: unknown
  requestId?: string | null
}

export async function audit(env: Env, e: AuditEvent): Promise<void> {
  try {
    const detail = e.detail === undefined ? null : JSON.stringify(e.detail)
    await env.DB
      .prepare(
        `INSERT INTO audit_log (ts, wallet, order_id, event, detail, request_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        Date.now(),
        e.wallet ?? null,
        e.orderId ?? null,
        e.event,
        detail,
        e.requestId ?? null,
      )
      .run()
  } catch (err) {
    console.error('audit_failed', { event: e.event, error: String(err) })
  }
}
