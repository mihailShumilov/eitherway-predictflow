// /orders/* routes — limit-order CRUD scoped to the authenticated wallet.
//
// Phase 1 scope: accept a Phase-2-shaped payload (signed tx + nonce + trigger
// metadata), encrypt the signed tx blob, persist. Listing and cancellation
// are wallet-scoped. The actual encryption is exercised by the auth path's
// JSON-only POSTs in v1; durable-nonce production wiring lands in Phase 2.

import { Hono } from 'hono'
import type { Env, AppVariables } from '../env'
import { audit } from '../lib/audit'
import { incr } from '../lib/metrics'
import { encrypt } from '../lib/encryption'
import { apiError } from '../lib/errors'
import { base64ToBytes, randomBytes, bytesToHex } from '../lib/crypto'
import { isValidPubkey } from '../lib/solana-auth'
import { SIGNED_TX_MIN_BYTES, SIGNED_TX_MAX_BYTES } from '../lib/constants'

const orders = new Hono<{ Bindings: Env; Variables: AppVariables }>()

const ORDER_TYPES = new Set(['limit', 'stop-loss', 'take-profit'])
const SIDES = new Set(['yes', 'no'])

orders.post('/', async (c) => {
  const wallet = c.var.wallet
  const body = await c.req.json<{
    marketTicker?: string
    marketId?: string
    eventTicker?: string
    side?: string
    orderType?: string
    triggerPrice?: number     // 0..1
    amountUsdc?: number
    yesMint?: string
    noMint?: string
    signedTxBase64?: string   // Phase 2 will require this; allow null in v1 for stub orders
    durableNoncePubkey?: string
    durableNonceValue?: string
  }>().catch(() => ({} as Record<string, never>))

  const errors: string[] = []
  if (!body.marketTicker || typeof body.marketTicker !== 'string') errors.push('marketTicker required')
  if (!body.side || !SIDES.has(body.side)) errors.push('side must be "yes" or "no"')
  if (!body.orderType || !ORDER_TYPES.has(body.orderType)) errors.push('invalid orderType')
  if (typeof body.triggerPrice !== 'number' || !(body.triggerPrice > 0 && body.triggerPrice < 1)) {
    errors.push('triggerPrice must be in (0, 1)')
  }
  if (typeof body.amountUsdc !== 'number' || !(body.amountUsdc > 0)) errors.push('amountUsdc must be > 0')
  if (body.yesMint && !isValidPubkey(body.yesMint)) errors.push('invalid yesMint')
  if (body.noMint && !isValidPubkey(body.noMint)) errors.push('invalid noMint')
  if (body.durableNoncePubkey && !isValidPubkey(body.durableNoncePubkey)) {
    errors.push('invalid durableNoncePubkey')
  }
  if (errors.length) return apiError(c, 400, 'validation_failed', errors)

  // Phase 2+: signed tx + durable nonce are required. Without them the
  // keeper has nothing to submit when the trigger crosses.
  if (!body.signedTxBase64) return apiError(c, 400, 'signed_tx_required')
  if (!body.durableNoncePubkey) return apiError(c, 400, 'durable_nonce_required')
  if (!body.durableNonceValue) return apiError(c, 400, 'durable_nonce_value_required')

  // Verify the nonce belongs to this wallet — a caller can't submit an
  // order signed against someone else's nonce account. Defense in depth:
  // the on-chain runtime would also reject it, but failing here saves a
  // submission round-trip and produces clearer audit trails.
  const nonceRow = await c.env.DB
    .prepare(
      `SELECT pubkey FROM durable_nonces
        WHERE wallet = ? AND pubkey = ? AND market_ticker = ?`,
    )
    .bind(wallet, body.durableNoncePubkey, body.marketTicker!)
    .first<{ pubkey: string }>()
  if (!nonceRow) {
    return apiError(c, 400, 'nonce_not_registered')
  }

  let signedTxBytes: Uint8Array
  try {
    signedTxBytes = base64ToBytes(body.signedTxBase64)
  } catch {
    return apiError(c, 400, 'invalid_signed_tx_base64')
  }
  // Solana's transaction packet limit is 1232 bytes; allow some headroom
  // for any future versioning but reject obvious garbage.
  if (signedTxBytes.length < SIGNED_TX_MIN_BYTES || signedTxBytes.length > SIGNED_TX_MAX_BYTES) {
    return apiError(c, 400, 'signed_tx_size_out_of_range')
  }
  const enc = await encrypt(signedTxBytes, c.env.SIGNED_TX_KEY)

  const id = bytesToHex(randomBytes(16))
  const now = Date.now()

  await c.env.DB
    .prepare(
      `INSERT INTO orders (
        id, wallet, market_ticker, market_id, event_ticker,
        side, order_type, trigger_price, amount_usdc,
        yes_mint, no_mint,
        signed_tx_enc, signed_tx_iv,
        durable_nonce, durable_nonce_value,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      id,
      wallet,
      body.marketTicker!,
      body.marketId ?? null,
      body.eventTicker ?? null,
      body.side!,
      body.orderType!,
      body.triggerPrice!,
      body.amountUsdc!,
      body.yesMint ?? null,
      body.noMint ?? null,
      enc.ciphertext,
      enc.iv,
      body.durableNoncePubkey ?? null,
      body.durableNonceValue ?? null,
      now,
      now,
    )
    .run()

  await audit(c.env, {
    wallet,
    orderId: id,
    event: 'order.created',
    detail: {
      marketTicker: body.marketTicker,
      side: body.side,
      orderType: body.orderType,
      triggerPrice: body.triggerPrice,
      amountUsdc: body.amountUsdc,
    },
    requestId: c.var.requestId,
  })
  await incr(c.env, 'order_created', { marketTicker: body.marketTicker, orderType: body.orderType })

  // Wake the PriceWatcher DO for this market — one DO instance per market
  // ticker, addressed by name. The DO opens a DFlow `prices` WS
  // subscription if it isn't already connected and starts evaluating
  // triggers. Best-effort: if the DO call fails (cold start, transient),
  // a periodic reconciler in Phase 6 will pick the order up.
  try {
    const stub = c.env.PRICE_WATCHER.get(c.env.PRICE_WATCHER.idFromName(body.marketTicker!))
    c.executionCtx.waitUntil(
      stub.fetch(`https://internal/wake?market=${encodeURIComponent(body.marketTicker!)}`)
        .catch((err) => console.error('price_watcher_wake_failed', { error: String(err), market: body.marketTicker })),
    )
  } catch (err) {
    console.error('price_watcher_wake_threw', { error: String(err) })
  }

  return c.json({ id, status: 'pending', createdAt: now }, 201)
})

orders.get('/', async (c) => {
  const wallet = c.var.wallet
  const status = c.req.query('status')   // optional filter
  const market = c.req.query('market')   // optional filter

  const conditions = ['wallet = ?']
  const binds: (string | number)[] = [wallet]
  if (status) {
    conditions.push('status = ?')
    binds.push(status)
  }
  if (market) {
    conditions.push('market_ticker = ?')
    binds.push(market)
  }

  const rows = await c.env.DB
    .prepare(
      `SELECT id, market_ticker, market_id, event_ticker, side, order_type,
              trigger_price, amount_usdc, status, failure_reason, fill_signature,
              fill_price, created_at, updated_at, triggered_at, filled_at,
              cancelled_at, durable_nonce
         FROM orders
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 200`,
    )
    .bind(...binds)
    .all()

  return c.json({ orders: rows.results ?? [] })
})

orders.get('/:id', async (c) => {
  const wallet = c.var.wallet
  const id = c.req.param('id')
  const row = await c.env.DB
    .prepare(
      `SELECT id, market_ticker, market_id, event_ticker, side, order_type,
              trigger_price, amount_usdc, status, failure_reason, fill_signature,
              fill_price, created_at, updated_at, triggered_at, filled_at,
              cancelled_at, durable_nonce
         FROM orders
        WHERE id = ? AND wallet = ?`,
    )
    .bind(id, wallet)
    .first()
  if (!row) return apiError(c, 404, 'not_found')
  return c.json(row)
})

orders.post('/:id/cancel', async (c) => {
  const wallet = c.var.wallet
  const id = c.req.param('id')
  const now = Date.now()

  // Only pending orders can be cancelled. Once `armed` or `submitting` we
  // race the keeper — it's racing toward a wallet-popup-less submission
  // anyway, so refuse. Phase 3+ will implement a soft-cancel that the
  // PriceWatcher DO checks before submitting.
  const upd = await c.env.DB
    .prepare(
      `UPDATE orders
          SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND wallet = ? AND status = 'pending'`,
    )
    .bind(now, now, id, wallet)
    .run()

  if (upd.meta.changes === 0) {
    const existing = await c.env.DB
      .prepare('SELECT status FROM orders WHERE id = ? AND wallet = ?')
      .bind(id, wallet)
      .first<{ status: string }>()
    if (!existing) return c.json({ error: 'not_found' }, 404)
    return apiError(c, 409, 'not_cancellable', { status: existing.status })
  }

  await audit(c.env, {
    wallet,
    orderId: id,
    event: 'order.cancelled',
    detail: { by: 'user' },
    requestId: c.var.requestId,
  })
  await incr(c.env, 'order_cancelled', { by: 'user' })

  return c.json({ id, status: 'cancelled', cancelledAt: now })
})

export default orders
