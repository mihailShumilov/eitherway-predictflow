// /durable-nonces/* — track which Solana nonce account a wallet uses for a
// given market. The keeper needs the (nonce, market) pair to:
//   - cross-check incoming /orders payloads (nonce must belong to caller)
//   - refresh the nonce value before submission (it advances on every fill)
//
// We intentionally don't store the nonce account's secret material — it's
// owned by the user's wallet, not us. We only record the pubkey + the
// last known on-chain nonce value. Phase 4 confirms a fresh nonce read
// before submitting.

import { Hono } from 'hono'
import type { Env, AppVariables } from '../env'
import { audit } from '../lib/audit'
import { isValidPubkey } from '../lib/solana-auth'
import { apiError } from '../lib/errors'
import { capturePh } from '../lib/posthog'

const nonces = new Hono<{ Bindings: Env; Variables: AppVariables }>()

type RegisterBody = {
  pubkey?: string
  marketTicker?: string
  currentNonce?: string
}

nonces.get('/', async (c) => {
  const wallet = c.var.wallet
  const market = c.req.query('market')
  if (!market) return apiError(c, 400, 'market_required')
  const row = await c.env.DB
    .prepare(
      `SELECT pubkey, market_ticker AS marketTicker, current_nonce AS currentNonce,
              created_at AS createdAt, updated_at AS updatedAt
         FROM durable_nonces
        WHERE wallet = ? AND market_ticker = ?`,
    )
    .bind(wallet, market)
    .first()
  if (!row) return apiError(c, 404, 'not_found')
  return c.json(row)
})

nonces.post('/', async (c) => {
  const wallet = c.var.wallet
  const body = await c.req.json<RegisterBody>().catch(() => ({} as RegisterBody))
  const errors: string[] = []
  if (!body.pubkey || !isValidPubkey(body.pubkey)) errors.push('pubkey invalid')
  if (!body.marketTicker || typeof body.marketTicker !== 'string') errors.push('marketTicker required')
  if (!body.currentNonce || typeof body.currentNonce !== 'string') errors.push('currentNonce required')
  if (errors.length) return apiError(c, 400, 'validation_failed', errors)

  const now = Date.now()

  // Block cross-wallet nonce-pubkey hijacking: if this pubkey already
  // exists in the table under a different wallet, refuse the registration.
  // Without this check, the ON CONFLICT(pubkey) UPDATE path below would
  // let an attacker with another wallet's nonce pubkey overwrite its
  // current_nonce field (causing the victim's next order to fail the
  // nonce cross-check in routes/orders.ts).
  const existingPubkey = await c.env.DB
    .prepare('SELECT wallet FROM durable_nonces WHERE pubkey = ?')
    .bind(body.pubkey!)
    .first<{ wallet: string }>()
  if (existingPubkey && existingPubkey.wallet !== wallet) {
    return apiError(c, 409, 'pubkey_owned_by_another_wallet')
  }

  // If this wallet had a different pubkey registered for this market
  // previously (e.g. they closed the old nonce account on-chain and
  // funded a fresh one), drop the prior row in the same transaction as
  // the upsert below. D1's `batch` is atomic — both statements commit or
  // neither does, so a Worker isolate killed mid-DELETE can't leave the
  // table in a partially-mutated state.
  const existingForPair = await c.env.DB
    .prepare('SELECT pubkey FROM durable_nonces WHERE wallet = ? AND market_ticker = ?')
    .bind(wallet, body.marketTicker!)
    .first<{ pubkey: string }>()

  const stmts = []
  if (existingForPair && existingForPair.pubkey !== body.pubkey) {
    stmts.push(
      c.env.DB
        .prepare('DELETE FROM durable_nonces WHERE wallet = ? AND market_ticker = ?')
        .bind(wallet, body.marketTicker!),
    )
  }
  // ON CONFLICT here is wallet-scoped — the pubkey-collision path is
  // already gated by the explicit cross-wallet check above. Including
  // `wallet = ?` in the WHERE narrows the update further, defense-in-depth.
  stmts.push(
    c.env.DB
      .prepare(
        `INSERT INTO durable_nonces (pubkey, wallet, market_ticker, current_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET
           current_nonce = excluded.current_nonce,
           updated_at = excluded.updated_at
          WHERE wallet = excluded.wallet`,
      )
      .bind(body.pubkey!, wallet, body.marketTicker!, body.currentNonce!, now, now),
  )
  await c.env.DB.batch(stmts)

  await audit(c.env, {
    wallet,
    event: 'durable_nonce.registered',
    detail: { pubkey: body.pubkey, marketTicker: body.marketTicker },
    requestId: c.var.requestId,
  })
  await capturePh(c.env, wallet, 'durable_nonce_registered', {
    nonce_pubkey: body.pubkey,
    market_ticker: body.marketTicker,
    rotated: !!(existingForPair && existingForPair.pubkey !== body.pubkey),
  })

  return c.json({ pubkey: body.pubkey, marketTicker: body.marketTicker, currentNonce: body.currentNonce })
})

export default nonces
