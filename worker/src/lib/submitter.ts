// On-chain submission path — split into two phases so neither blocks
// inside a single Worker invocation past its CPU/wall-time budget.
//
//   submitOrder(env, orderId):
//     - claim row (armed → submitting, CAS)
//     - decrypt signed tx
//     - sendRawTransaction via Helius
//     - on success: persist `fill_signature`, leave status = 'submitting'
//     - on permanent failure: mark 'failed'
//     - on transient failure: roll back to 'armed', alarm re-fires
//
//   checkSubmittedOrder(env, orderId):
//     - called by PriceWatcher's alarm cycle for any 'submitting' row
//       whose fill_signature is non-null
//     - single-shot getSignatureStatuses call (no inline poll loop)
//     - on confirmed: mark 'filled'
//     - on tx-level error: mark 'failed'
//     - otherwise: leave alone, next alarm tries again
//
// Why split: Workers have ~30s wall-time per invocation; a 60s inline
// poll loop can be killed mid-await leaving the row stuck. The alarm
// scheduler IS the polling loop now — every ALARM_REEVAL_MS the DO
// re-checks every submitted row in its market.
//
// Reap interaction: the reaper at lib/priceWatcher.ts only reaps rows
// in `submitting` with NO `fill_signature` (i.e., the send itself
// stalled). Rows that broadcast successfully stay in `submitting` until
// the alarm sees confirmation; the durable nonce protects against
// double-spend even if the reaper misclassifies.
//
// We do NOT advance the durable nonce ourselves — Solana's runtime does
// that atomically when the tx confirms. We refresh our cached nonce
// value via `/durable-nonces` register on the next order placement.

import type { Env } from '../env'
import { decrypt } from './encryption'
import { audit } from './audit'
import { incr } from './metrics'
import { bytesToBase64 } from './crypto'
import { CONFIRMATION_GIVE_UP_MS } from './constants'

type OrderRowFull = {
  id: string
  wallet: string
  market_ticker: string
  side: string
  order_type: string
  amount_usdc: number
  trigger_price: number
  signed_tx_enc: ArrayBuffer
  signed_tx_iv: ArrayBuffer
  durable_nonce: string | null
  status: string
}

type OrderRowConfirmation = {
  id: string
  wallet: string
  market_ticker: string
  trigger_price: number
  fill_signature: string
  updated_at: number
}

export async function submitOrder(env: Env, orderId: string): Promise<void> {
  // INVARIANT: this query lacks a `wallet = ?` predicate because the only
  // caller is `priceWatcher.armAndSubmit`, which sourced `orderId` from a
  // CAS-armed row in the same DO. If you add a caller that takes
  // `orderId` from user input, ADD `AND wallet = ?` here — otherwise
  // tenancy is broken (any wallet could submit any order id).
  const row = await env.DB
    .prepare(
      `SELECT id, wallet, market_ticker, side, order_type, amount_usdc,
              trigger_price, signed_tx_enc, signed_tx_iv, durable_nonce, status
         FROM orders
        WHERE id = ?`,
    )
    .bind(orderId)
    .first<OrderRowFull>()

  if (!row) {
    console.error('submit_order_missing', { id: orderId })
    return
  }
  if (row.status !== 'armed') return

  // armed → submitting (CAS). Two concurrent calls can't both broadcast.
  const claimed = await env.DB
    .prepare(`UPDATE orders SET status = 'submitting', updated_at = ? WHERE id = ? AND status = 'armed'`)
    .bind(Date.now(), orderId)
    .run()
  if (claimed.meta.changes === 0) return

  let signedBytes: Uint8Array
  try {
    const enc = {
      iv: new Uint8Array(row.signed_tx_iv),
      ciphertext: new Uint8Array(row.signed_tx_enc),
    }
    signedBytes = await decrypt(enc, env.SIGNED_TX_KEY)
  } catch (err) {
    await markFailed(env, row, `decrypt_failed: ${String(err)}`)
    return
  }

  await incr(env, 'submit_attempted', { marketTicker: row.market_ticker })
  console.log('submit_order_attempt', { id: orderId, marketTicker: row.market_ticker, txBytes: signedBytes.length })
  const sigResult = await sendRawTransaction(env, signedBytes)
  if (!sigResult.ok) {
    console.error('submit_order_send_failed', { id: orderId, permanent: sigResult.permanent, error: sigResult.error })
    if (sigResult.permanent) {
      await markFailed(env, row, sigResult.error)
      await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: sigResult.error })
    } else {
      await env.DB
        .prepare(`UPDATE orders SET status = 'armed', updated_at = ? WHERE id = ? AND status = 'submitting'`)
        .bind(Date.now(), orderId)
        .run()
      await audit(env, {
        wallet: row.wallet,
        orderId: row.id,
        event: 'submit.transient_failure',
        detail: { error: sigResult.error },
      })
      await incr(env, 'submit_failed_transient', { marketTicker: row.market_ticker })
    }
    return
  }

  // Broadcast succeeded — persist the signature and leave the row in
  // `submitting`. The alarm cycle will pick it up for confirmation polling.
  await env.DB
    .prepare(`UPDATE orders SET fill_signature = ?, updated_at = ? WHERE id = ?`)
    .bind(sigResult.signature, Date.now(), orderId)
    .run()
  console.log('submit_order_broadcast', { id: orderId, signature: sigResult.signature })
  await audit(env, {
    wallet: row.wallet,
    orderId: row.id,
    event: 'submit.broadcast',
    detail: { signature: sigResult.signature, marketTicker: row.market_ticker },
  })
}

// Single-shot confirmation check, called from the alarm cycle. Does NOT
// loop — if the tx isn't confirmed yet, we just leave the row alone for
// the next alarm to re-check.
export async function checkSubmittedOrder(env: Env, orderId: string): Promise<void> {
  const row = await env.DB
    .prepare(
      `SELECT id, wallet, market_ticker, trigger_price, fill_signature, updated_at
         FROM orders
        WHERE id = ? AND status = 'submitting' AND fill_signature IS NOT NULL`,
    )
    .bind(orderId)
    .first<OrderRowConfirmation>()
  if (!row) return  // moved to filled/failed/cancelled by another path

  const status = await getSignatureStatus(env, row.fill_signature)
  const ageMs = Date.now() - row.updated_at
  console.log('check_submitted_order', {
    id: orderId,
    signature: row.fill_signature,
    confirmed: status.confirmed,
    error: status.error ?? null,
    ageMs,
  })
  if (status.error) {
    await markFailed(env, row, status.error)
    await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: status.error })
    return
  }
  if (status.confirmed) {
    const now = Date.now()
    await env.DB
      .prepare(
        `UPDATE orders SET status = 'filled', fill_price = ?, filled_at = ?, updated_at = ?
          WHERE id = ? AND status = 'submitting'`,
      )
      .bind(row.trigger_price, now, now, row.id)
      .run()
    console.log('order_filled', { id: orderId, signature: row.fill_signature })
    await audit(env, {
      wallet: row.wallet,
      orderId: row.id,
      event: 'order.filled',
      detail: { signature: row.fill_signature, marketTicker: row.market_ticker },
    })
    await incr(env, 'order_filled', { marketTicker: row.market_ticker })
    await incr(env, 'submit_succeeded', { marketTicker: row.market_ticker })
    return
  }
  // Confirmation neither succeeded nor errored. If the broadcast was a
  // long time ago, the tx almost certainly never landed (most often a
  // durable-nonce mismatch — the runtime rejects pre-inclusion, so
  // getSignatureStatuses returns null indefinitely). Give up so the row
  // doesn't poll forever.
  if (ageMs > CONFIRMATION_GIVE_UP_MS) {
    console.error('check_submitted_order_timeout', { id: orderId, signature: row.fill_signature, ageMs })
    await markFailed(env, row, `confirmation_timeout_after_${Math.floor(ageMs / 1000)}s`)
    await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: 'confirmation_timeout' })
    return
  }
  // Otherwise leave alone; next alarm re-checks.
}

async function markFailed(env: Env, row: { id: string; wallet: string }, reason: string): Promise<void> {
  const now = Date.now()
  await env.DB
    .prepare(`UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(reason.slice(0, 500), now, row.id)
    .run()
  await audit(env, {
    wallet: row.wallet,
    orderId: row.id,
    event: 'order.failed',
    detail: { reason },
  })
}

type SendResult =
  | { ok: true; signature: string }
  | { ok: false; permanent: boolean; error: string }

async function sendRawTransaction(env: Env, bytes: Uint8Array): Promise<SendResult> {
  // base64-encode for the JSON-RPC body. Use the chunked helper, NOT
  // `btoa(String.fromCharCode(...bytes))` — spreading a Uint8Array as
  // function args hits the JS call-stack arg limit on V8.
  const b64 = bytesToBase64(bytes)
  let res: Response
  try {
    res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        // maxRetries: 5 — Helius will rebroadcast up to 5 times if the
        // leader doesn't include the tx within ~30s of each send. Without
        // retries, low-priority txs that get dropped under congestion stay
        // dropped forever and surface as "not found" on solscan even though
        // the signature is valid. We pair this with the priority fee
        // embedded by DFlow's /order so each rebroadcast is increasingly
        // likely to land. Durable nonces guarantee no double-spend across
        // retries — at most one inclusion can advance the nonce.
        params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }],
      }),
    })
  } catch (err) {
    return { ok: false, permanent: false, error: `rpc_unreachable: ${String(err)}` }
  }
  if (!res.ok) {
    return { ok: false, permanent: res.status >= 400 && res.status < 500, error: `rpc_${res.status}` }
  }
  let body: any
  try { body = await res.json() } catch { return { ok: false, permanent: false, error: 'rpc_bad_json' } }
  if (body.error) {
    const code = body.error.code
    const message = body.error.message ?? 'rpc_error'
    const permanentCodes = new Set([
      -32602,  // invalid params (malformed tx)
      -32003,  // BlockhashNotFound — for durable nonce, stale nonce
      -32004,  // BlockNotAvailable
    ])
    // -32005 NodeUnhealthy is transient — exclude from the permanent set.
    return {
      ok: false,
      permanent: permanentCodes.has(code),
      error: `${code}:${message}`.slice(0, 500),
    }
  }
  if (typeof body.result !== 'string') {
    return { ok: false, permanent: false, error: 'rpc_no_signature' }
  }
  return { ok: true, signature: body.result }
}

type StatusResult = { confirmed: boolean; error?: string }

async function getSignatureStatus(env: Env, signature: string): Promise<StatusResult> {
  try {
    const res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    })
    if (!res.ok) return { confirmed: false }
    const body: any = await res.json().catch(() => null)
    const status = body?.result?.value?.[0]
    if (!status) return { confirmed: false }
    if (status.err) {
      return { confirmed: false, error: `tx_error:${JSON.stringify(status.err).slice(0, 200)}` }
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { confirmed: true }
    }
    return { confirmed: false }
  } catch {
    return { confirmed: false }
  }
}
