// /orders/* routes — order CRUD scoped to the authenticated wallet.
//
// Two flows coexist:
//   - durable_nonce_legacy: client signs a full swap tx with a durable
//     nonce; keeper broadcasts at trigger time. Works on any wallet that
//     does NOT inject Lighthouse-style assertions (Solflare, Backpack).
//   - approval: client signs only an spl-token approve; keeper builds and
//     signs the swap tx server-side at trigger time using the executor key.
//     Works on Phantom (Lighthouse-immune since approve has no nonce
//     position-0 invariant).

import { Hono, type Context } from 'hono'
import type { Env, AppVariables } from '../env'
import { audit } from '../lib/audit'
import { incr } from '../lib/metrics'
import { encrypt } from '../lib/encryption'
import { apiError } from '../lib/errors'
import { base64ToBytes, randomBytes, bytesToHex } from '../lib/crypto'
import { isValidPubkey } from '../lib/solana-auth'
import { SIGNED_TX_MIN_BYTES, SIGNED_TX_MAX_BYTES } from '../lib/constants'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

const orders = new Hono<{ Bindings: Env; Variables: AppVariables }>()

const ORDER_TYPES = new Set(['limit', 'stop-loss', 'take-profit'])
const SIDES = new Set(['yes', 'no'])

// Solana base58 signatures decode to 64 bytes; encoded length is 87–88 chars.
const BASE58_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/

type OrderBody = {
  marketTicker?: string
  marketId?: string
  eventTicker?: string
  side?: string
  orderType?: string
  triggerPrice?: number
  amountUsdc?: number
  yesMint?: string
  noMint?: string

  flow?: 'durable_nonce_legacy' | 'approval'

  // Legacy durable-nonce flow.
  signedTxBase64?: string
  durableNoncePubkey?: string
  durableNonceValue?: string

  // Approval flow.
  approvalSignature?: string
  delegatedAmountAtPlacement?: number
  userInputAta?: string
  inputMint?: string
  outputMint?: string
}

function validateCommon(body: OrderBody, flow: string): string[] {
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
  if (flow !== 'durable_nonce_legacy' && flow !== 'approval') {
    errors.push('flow must be "durable_nonce_legacy" or "approval"')
  }
  return errors
}

// Approval flow direction matrix:
//   limit (BUY):       inputMint = USDC, outputMint = outcome (yes/no by side)
//   stop-loss SELL:    inputMint = outcome, outputMint = USDC
//   take-profit SELL:  inputMint = outcome, outputMint = USDC
function expectedDirection(
  body: OrderBody,
  usdcMint: string,
): { inputMint: string; outputMint: string } | { error: string } {
  const outcome = body.side === 'yes' ? body.yesMint : body.noMint
  if (!outcome || !isValidPubkey(outcome)) {
    return { error: `${body.side}Mint required for approval flow` }
  }
  if (body.orderType === 'limit') {
    return { inputMint: usdcMint, outputMint: outcome }
  }
  // stop-loss / take-profit
  return { inputMint: outcome, outputMint: usdcMint }
}

function validateApprovalFields(
  body: OrderBody,
  wallet: string,
  usdcMint: string,
): { ok: true; inputMint: string; outputMint: string; expectedAta: string; atomic: number }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!body.approvalSignature || typeof body.approvalSignature !== 'string'
      || !BASE58_SIGNATURE_RE.test(body.approvalSignature)) {
    errors.push('approvalSignature must be a base58-encoded Solana signature')
  }
  if (typeof body.delegatedAmountAtPlacement !== 'number' || !(body.delegatedAmountAtPlacement > 0)) {
    errors.push('delegatedAmountAtPlacement must be a positive integer')
  }
  if (!body.userInputAta || !isValidPubkey(body.userInputAta)) {
    errors.push('userInputAta must be a valid base58 pubkey')
  }
  if (!body.inputMint || !isValidPubkey(body.inputMint)) {
    errors.push('inputMint must be a valid base58 pubkey')
  }
  if (!body.outputMint || !isValidPubkey(body.outputMint)) {
    errors.push('outputMint must be a valid base58 pubkey')
  }
  if (errors.length) return { ok: false, errors }

  // Server-derived expected direction. Reject if the client's claim drifts.
  const direction = expectedDirection(body, usdcMint)
  if ('error' in direction) return { ok: false, errors: [direction.error] }
  if (body.inputMint !== direction.inputMint) {
    errors.push(`inputMint mismatch for ${body.orderType}/${body.side}: expected ${direction.inputMint}`)
  }
  if (body.outputMint !== direction.outputMint) {
    errors.push(`outputMint mismatch for ${body.orderType}/${body.side}: expected ${direction.outputMint}`)
  }
  if (errors.length) return { ok: false, errors }

  // userInputAta MUST be the SIWS wallet's ATA on the inputMint. This is
  // the load-bearing check that prevents one user from claiming another
  // user's ATA in their order row.
  let expectedAta: string
  try {
    expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(body.inputMint!),
      new PublicKey(wallet),
    ).toBase58()
  } catch (err) {
    return { ok: false, errors: [`pubkey_decode_failed: ${String(err)}`] }
  }
  if (body.userInputAta !== expectedAta) {
    errors.push('userInputAta does not match wallet+inputMint ATA')
  }
  if (errors.length) return { ok: false, errors }

  return {
    ok: true,
    inputMint: direction.inputMint,
    outputMint: direction.outputMint,
    expectedAta,
    atomic: Math.floor(body.delegatedAmountAtPlacement!),
  }
}

async function insertApprovalOrder(
  env: Env,
  id: string,
  wallet: string,
  body: OrderBody,
  derived: { inputMint: string; outputMint: string; expectedAta: string; atomic: number },
  now: number,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO orders (
        id, wallet, market_ticker, market_id, event_ticker,
        side, order_type, trigger_price, amount_usdc,
        yes_mint, no_mint,
        flow, approval_signature, delegated_amount_at_placement,
        user_input_ata, input_mint, output_mint,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
      'approval',
      body.approvalSignature!,
      derived.atomic,
      derived.expectedAta,
      derived.inputMint,
      derived.outputMint,
      now,
      now,
    )
    .run()

  // Audit ledger. Source of truth at fire time is the on-chain
  // delegated_amount; this is for history/dispute investigation only.
  try {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO token_approvals
          (signature, wallet, token_account, mint, delegate, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        body.approvalSignature!,
        wallet,
        derived.expectedAta,
        derived.inputMint,
        'executor',
        derived.atomic,
        now,
      )
      .run()
  } catch (err) {
    console.error('token_approval_insert_failed', { error: String(err), id })
  }
}

async function insertLegacyOrder(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  id: string,
  wallet: string,
  body: OrderBody,
  now: number,
): Promise<Response | void> {
  if (!body.signedTxBase64) return apiError(c, 400, 'signed_tx_required')
  if (!body.durableNoncePubkey) return apiError(c, 400, 'durable_nonce_required')
  if (!body.durableNonceValue) return apiError(c, 400, 'durable_nonce_value_required')
  if (!isValidPubkey(body.durableNoncePubkey)) {
    return apiError(c, 400, 'validation_failed', ['invalid durableNoncePubkey'])
  }

  const nonceRow = await c.env.DB
    .prepare(
      `SELECT pubkey FROM durable_nonces
        WHERE wallet = ? AND pubkey = ? AND market_ticker = ?`,
    )
    .bind(wallet, body.durableNoncePubkey, body.marketTicker!)
    .first<{ pubkey: string }>()
  if (!nonceRow) return apiError(c, 400, 'nonce_not_registered')

  let signedTxBytes: Uint8Array
  try {
    signedTxBytes = base64ToBytes(body.signedTxBase64)
  } catch {
    return apiError(c, 400, 'invalid_signed_tx_base64')
  }
  if (signedTxBytes.length < SIGNED_TX_MIN_BYTES || signedTxBytes.length > SIGNED_TX_MAX_BYTES) {
    return apiError(c, 400, 'signed_tx_size_out_of_range')
  }
  const enc = await encrypt(signedTxBytes, c.env.SIGNED_TX_KEY)

  await c.env.DB
    .prepare(
      `INSERT INTO orders (
        id, wallet, market_ticker, market_id, event_ticker,
        side, order_type, trigger_price, amount_usdc,
        yes_mint, no_mint,
        signed_tx_enc, signed_tx_iv,
        durable_nonce, durable_nonce_value,
        flow, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
      'durable_nonce_legacy',
      now,
      now,
    )
    .run()
}

orders.post('/', async (c) => {
  const wallet = c.var.wallet
  const body = await c.req.json<OrderBody>().catch(() => ({} as OrderBody))
  const flow = body.flow ?? 'durable_nonce_legacy'

  const errors = validateCommon(body, flow)
  if (errors.length) return apiError(c, 400, 'validation_failed', errors)

  // One non-terminal keeper order per (wallet, market) — applies to BOTH
  // flows. Legacy: durable-nonce sharing problem. Approval: re-approve
  // accounting depends on a single-active-order policy.
  const existingNonTerminal = await c.env.DB
    .prepare(
      `SELECT id FROM orders
        WHERE wallet = ? AND market_ticker = ?
          AND status IN ('pending', 'armed', 'submitting')
        LIMIT 1`,
    )
    .bind(wallet, body.marketTicker!)
    .first<{ id: string }>()
  if (existingNonTerminal) {
    return apiError(c, 409, 'duplicate_pending_order', {
      existingId: existingNonTerminal.id,
      detail: 'Cancel the existing order for this market before placing another.',
    })
  }

  const id = bytesToHex(randomBytes(16))
  const now = Date.now()

  if (flow === 'approval') {
    const result = validateApprovalFields(body, wallet, c.env.USDC_MINT)
    if (!result.ok) return apiError(c, 400, 'validation_failed', result.errors)
    await insertApprovalOrder(c.env, id, wallet, body, result, now)
  } else {
    const legacyError = await insertLegacyOrder(c, id, wallet, body, now)
    if (legacyError) return legacyError
  }

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
      flow,
    },
    requestId: c.var.requestId,
  })
  await incr(c.env, 'order_created', { marketTicker: body.marketTicker, orderType: body.orderType, flow })

  if (flow === 'approval') {
    try {
      const { warmExecutorNonceForMarket } = await import('../lib/approvalSubmitter')
      c.executionCtx.waitUntil(
        warmExecutorNonceForMarket(c.env, body.marketTicker!).catch((err) =>
          console.error('warm_executor_nonce_failed', { error: String(err), market: body.marketTicker })
        ),
      )
    } catch (err) {
      console.error('warm_executor_nonce_dispatch_failed', { error: String(err) })
    }
  }

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
  const status = c.req.query('status')
  const market = c.req.query('market')

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
              cancelled_at, durable_nonce,
              flow, approval_signature, delegated_amount_at_placement,
              user_input_ata, input_mint, output_mint
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
              cancelled_at, durable_nonce,
              flow, approval_signature, delegated_amount_at_placement,
              user_input_ata, input_mint, output_mint
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

  const upd = await c.env.DB
    .prepare(
      `UPDATE orders
          SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND wallet = ? AND status IN ('pending', 'armed', 'submitting')`,
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

// Bulk-cancel non-terminal approval-flow orders whose input_mint is in the
// supplied list. Used by the frontend's revoke flow so the keeper can't
// keep firing into a wiped delegation. Body: { mints: string[] }.
orders.post('/cancel-by-mint', async (c) => {
  const wallet = c.var.wallet
  const body = await c.req.json<{ mints?: string[] }>().catch(() => ({} as { mints?: string[] }))
  const mints = (body.mints ?? []).filter((m: string) => typeof m === 'string' && isValidPubkey(m))
  if (mints.length === 0) return apiError(c, 400, 'mints_required')

  const placeholders = mints.map(() => '?').join(',')
  const now = Date.now()
  const upd = await c.env.DB
    .prepare(
      `UPDATE orders
          SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE wallet = ? AND flow = 'approval'
          AND input_mint IN (${placeholders})
          AND status IN ('pending', 'armed', 'submitting')`,
    )
    .bind(now, now, wallet, ...mints)
    .run()

  const cancelled = upd.meta.changes ?? 0
  if (cancelled > 0) {
    await audit(c.env, {
      wallet,
      event: 'orders.cancelled_by_mint',
      detail: { count: cancelled, mints },
      requestId: c.var.requestId,
    })
    await incr(c.env, 'order_cancelled', { by: 'revoke', count: String(cancelled) })
  }
  return c.json({ cancelled, mints })
})

// Hard-delete terminal-state orders (cancelled / failed / expired) for
// this wallet. Optional `?market=<ticker>` narrows to one market. Audit
// rows persist independently for post-mortem.
orders.delete('/', async (c) => {
  const wallet = c.var.wallet
  const market = c.req.query('market')

  const conditions = [`wallet = ?`, `status IN ('cancelled', 'failed', 'expired')`]
  const binds: (string | number)[] = [wallet]
  if (market) {
    conditions.push('market_ticker = ?')
    binds.push(market)
  }

  const result = await c.env.DB
    .prepare(`DELETE FROM orders WHERE ${conditions.join(' AND ')}`)
    .bind(...binds)
    .run()

  const removed = result.meta.changes ?? 0
  if (removed > 0) {
    await audit(c.env, {
      wallet,
      event: 'orders.cleared',
      detail: { count: removed, market: market ?? null },
      requestId: c.var.requestId,
    })
  }
  return c.json({ removed })
})

export default orders
