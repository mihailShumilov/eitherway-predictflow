// Auth middleware — validates the bearer token, populates context with the
// verified wallet. Routes downstream MUST scope every D1 query by
// `c.var.wallet` (the session-bound pubkey) — there is no DB-level row
// security on D1, so leaking that scope = exposing other users' orders.

import type { Context, Next } from 'hono'
import type { Env, AppVariables } from '../env'
import { verifySessionToken } from '../lib/session'
import { apiError } from '../lib/errors'

export async function requireSession(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next,
) {
  const auth = c.req.header('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return apiError(c, 401, 'missing_authorization')
  }
  const token = auth.slice('Bearer '.length).trim()
  const payload = verifySessionToken(token, c.env.SESSION_SIGNING_KEY)
  if (!payload) return apiError(c, 401, 'invalid_token')

  // Defence-in-depth: check the session table for revocation. A token can be
  // structurally valid (HMAC verifies, not expired) but server-side revoked
  // by a future `DELETE /auth/session/:sid` or by a security incident.
  const row = await c.env.DB
    .prepare('SELECT revoked_at FROM sessions WHERE id = ? AND wallet = ?')
    .bind(payload.sid, payload.wallet)
    .first<{ revoked_at: number | null }>()
  if (!row) return apiError(c, 401, 'session_not_found')
  if (row.revoked_at) return apiError(c, 401, 'session_revoked')

  c.set('wallet', payload.wallet)
  c.set('sessionId', payload.sid)
  await next()
}
