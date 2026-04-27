// Lightweight counter metrics persisted to the audit log so they show up
// in the same query surface as state transitions. Production-grade
// observability (Logflare / Workers Analytics Engine) is out of scope
// for v1 — this is enough to answer "how many fills succeeded last
// hour?" via D1 SQL without standing up extra infra.

import type { Env } from '../env'
import { audit } from './audit'

export type MetricName =
  | 'order_created'
  | 'trigger_fired'
  | 'submit_attempted'
  | 'submit_succeeded'
  | 'submit_failed_permanent'
  | 'submit_failed_transient'
  | 'order_filled'
  | 'order_cancelled'
  | 'ws_disconnect'
  | 'ws_reconnect'

// Increment by 1; record dimensions (e.g. market) in the detail field
// so we can dice the audit_log by event/market later.
export async function incr(env: Env, name: MetricName, dims?: Record<string, unknown>): Promise<void> {
  await audit(env, {
    event: `metric.${name}`,
    detail: dims,
  })
}
