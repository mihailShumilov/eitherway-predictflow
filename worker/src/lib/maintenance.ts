// Periodic housekeeping for unbounded tables. Called (throttled) from the
// PriceWatcher alarm. Every statement is idempotent, so running it from
// multiple DOs or repeatedly is harmless.

import type { Env } from '../env'

// Run housekeeping at most this often per DO.
export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

// Keep a rolling window of audit history. The log is append-only and grows
// with every challenge/trigger/submit event.
const AUDIT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export async function runMaintenance(env: Env, now: number): Promise<void> {
  // Expired sign-in challenges. They're single-use and short-lived, but
  // abandoned sign-ins and floods would otherwise accumulate forever.
  await env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now).run()
  // Bound audit_log growth.
  await env.DB.prepare('DELETE FROM audit_log WHERE ts < ?').bind(now - AUDIT_LOG_RETENTION_MS).run()
}
