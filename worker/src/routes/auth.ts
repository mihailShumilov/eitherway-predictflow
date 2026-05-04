// /auth/* routes — Sign-in with Solana challenge/verify + session lifecycle.

import { Hono } from 'hono'
import type { Env, AppVariables } from '../env'
import { createChallenge, verifyChallenge, isValidPubkey, ChallengeError } from '../lib/solana-auth'
import { mintSessionToken, newSessionId, verifySessionToken } from '../lib/session'
import { audit } from '../lib/audit'
import { apiError } from '../lib/errors'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '../lib/crypto'
import { parseAllowlist, matchAllowedOrigin } from '../lib/origin'
import { capturePh, identifyWallet } from '../lib/posthog'

// Audit logs persist forever. Logging the raw `sid` would mean a future
// read-only D1 leak hands an attacker every active session id — combined
// with any future leak of `SESSION_SIGNING_KEY` (separate threat surface)
// they could mint replay tokens for any historical session. Hash for
// correlation without preserving the live secret-component value.
function sidDigest(sid: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(sid))).slice(0, 16)
}

const auth = new Hono<{ Bindings: Env; Variables: AppVariables }>()

type ChallengeBody = { wallet?: string }
type VerifyBody = { wallet?: string; nonce?: string; signature?: string }

auth.post('/challenge', async (c) => {
  const body = await c.req.json<ChallengeBody>().catch(() => ({} as ChallengeBody))
  const wallet = body.wallet?.trim() || ''
  if (!isValidPubkey(wallet)) {
    return apiError(c, 400, 'invalid_wallet')
  }

  // Pin both `domain` and `uri` to the request's Origin, but ONLY after
  // verifying it matches the configured allowlist. The wallet's SIWS prompt
  // renders `domain` prominently, so deriving it from an unverified Host
  // header would let a phishing site that proxies the worker via a different
  // hostname display its own domain to the user. The user's signature would
  // then verify against the attacker's stored message and could be replayed
  // against the legitimate worker. Resolving via the allowlist keeps the same
  // guarantee while supporting multiple legitimate frontends (prod + preview).
  const allowList = parseAllowlist(c.env.ALLOWED_ORIGIN)
  if (allowList.length === 0) {
    return apiError(c, 500, 'server_misconfigured', 'ALLOWED_ORIGIN is empty')
  }
  const requestOrigin = matchAllowedOrigin(c.req.header('origin'), allowList)
  if (!requestOrigin) {
    return apiError(c, 403, 'origin_not_allowed', 'Request origin is not in the allowlist')
  }
  let allowedHost: string
  try {
    allowedHost = new URL(requestOrigin).host
  } catch {
    return apiError(c, 500, 'server_misconfigured', 'ALLOWED_ORIGIN entry is not a valid URL')
  }
  let challenge
  try {
    challenge = await createChallenge({
      db: c.env.DB,
      domain: allowedHost,
      uri: requestOrigin,
      chainId: c.env.SOLANA_NETWORK,
      wallet,
    })
  } catch (err) {
    if (err instanceof ChallengeError) {
      // ChallengeError is only thrown for input validation (400) right now.
      // If new statuses are added, narrow them here rather than passing a
      // bare number — Hono's c.json status param is a typed enum.
      return apiError(c, 400, 'invalid_input', err.message)
    }
    throw err
  }

  await audit(c.env, {
    wallet,
    event: 'auth.challenge.issued',
    detail: { nonce: challenge.nonce },
    requestId: c.var.requestId,
  })

  await capturePh(c.env, wallet, 'auth_challenge_issued', {
    network: c.env.SOLANA_NETWORK,
    origin: requestOrigin,
  })

  return c.json({
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAt: challenge.expires_at,
  })
})

auth.post('/verify', async (c) => {
  const body = await c.req.json<VerifyBody>().catch(() => ({} as VerifyBody))

  const wallet = body.wallet?.trim() || ''
  const nonce = body.nonce?.trim() || ''
  const signature = body.signature?.trim() || ''

  if (!isValidPubkey(wallet) || !nonce || !signature) {
    return apiError(c, 400, 'missing_fields')
  }

  const result = await verifyChallenge({
    db: c.env.DB,
    wallet,
    nonce,
    signatureBase58: signature,
  })
  if (!result.ok) {
    await audit(c.env, {
      wallet,
      event: 'auth.verify.rejected',
      detail: { reason: result.reason, nonce },
      requestId: c.var.requestId,
    })
    await capturePh(c.env, wallet, 'auth_verify_failed', { reason: result.reason })
    return apiError(c, 401, 'verify_failed', result.reason)
  }

  // Mint session.
  // Validate SESSION_TTL_SECONDS aggressively — a typo'd env var would
  // produce `NaN` expiries that silently reject every future token.
  // Loud failure on the auth path beats a mystery total-auth-outage.
  const ttlSeconds = Number(c.env.SESSION_TTL_SECONDS)
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return apiError(c, 500, 'server_misconfigured', 'SESSION_TTL_SECONDS must be a positive number')
  }
  const sid = newSessionId()
  const now = Date.now()
  const exp = now + ttlSeconds * 1000
  await c.env.DB
    .prepare(
      `INSERT INTO sessions (id, wallet, issued_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sid,
      wallet,
      now,
      exp,
      c.req.header('user-agent') ?? null,
      c.req.header('cf-connecting-ip') ?? null,
    )
    .run()

  const token = mintSessionToken(
    { sid, wallet, iat: now, exp },
    c.env.SESSION_SIGNING_KEY,
  )

  await audit(c.env, {
    wallet,
    event: 'auth.session.minted',
    detail: { sidHash: sidDigest(sid), exp },
    requestId: c.var.requestId,
  })

  await identifyWallet(c.env, wallet, {
    last_session_minted_at: now,
    last_session_expires_at: exp,
    last_session_user_agent: c.req.header('user-agent') ?? null,
  })
  await capturePh(c.env, wallet, 'user_signed_in', {
    session_id: sid,
    ttl_seconds: ttlSeconds,
  })

  return c.json({ token, expiresAt: exp, wallet, sessionId: sid })
})

// Lightweight introspection: does this token still verify?
// Used by frontend to keep the user signed in across page reloads.
auth.get('/me', async (c) => {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return c.json({ wallet: null }, 200)
  const payload = verifySessionToken(header.slice(7).trim(), c.env.SESSION_SIGNING_KEY)
  if (!payload) return c.json({ wallet: null }, 200)
  const row = await c.env.DB
    .prepare('SELECT revoked_at, expires_at FROM sessions WHERE id = ?')
    .bind(payload.sid)
    .first<{ revoked_at: number | null; expires_at: number }>()
  if (!row || row.revoked_at || row.expires_at < Date.now()) return c.json({ wallet: null }, 200)
  return c.json({ wallet: payload.wallet, expiresAt: row.expires_at, sessionId: payload.sid })
})

// Allow the user (or the user-agent on logout) to revoke the current session.
auth.post('/logout', async (c) => {
  const header = c.req.header('authorization')
  if (!header?.startsWith('Bearer ')) return c.json({ ok: true })
  const payload = verifySessionToken(header.slice(7).trim(), c.env.SESSION_SIGNING_KEY)
  if (!payload) return c.json({ ok: true })
  await c.env.DB
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
    .bind(Date.now(), payload.sid)
    .run()
  await audit(c.env, {
    wallet: payload.wallet,
    event: 'auth.session.revoked',
    detail: { sidHash: sidDigest(payload.sid), by: 'user' },
    requestId: c.var.requestId,
  })

  await capturePh(c.env, payload.wallet, 'user_signed_out', { session_id: payload.sid })

  return c.json({ ok: true })
})

export default auth
