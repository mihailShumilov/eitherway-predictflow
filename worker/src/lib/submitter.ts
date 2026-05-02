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
import { CONFIRMATION_GIVE_UP_MS } from './constants'
import { sendRawTransaction, getSignatureStatusWithRetry } from './heliusRpc'
import { markOrderFailed } from './orderState'
import { classifyRpcError, type FailureCode } from './failureReason'

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
  // Encrypted signed-tx bytes used to re-broadcast a not-yet-landed tx
  // when validators didn't pick it up before Helius's maxRetries
  // exhausted. Both columns are nullable: legacy-flow rows always have
  // them (frontend signed); approval-flow rows only get them populated
  // after the keeper's first successful broadcast.
  signed_tx_enc: ArrayBuffer | null
  signed_tx_iv: ArrayBuffer | null
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
    await markFailed(env, row, 'decrypt_failed', `decrypt_failed: ${String(err)}`)
    return
  }

  await incr(env, 'submit_attempted', { marketTicker: row.market_ticker })
  console.log('submit_order_attempt', {
    id: orderId,
    marketTicker: row.market_ticker,
    txBytes: signedBytes.length,
  })

  // Pre-flight check: ensure advanceNonceAccount is at instruction position 0.
  // If a wallet (e.g. Phantom) injected Lighthouse / Smart-Transaction
  // safety instructions ahead of it, the durable-nonce protocol breaks and
  // the runtime rejects the tx pre-inclusion (Helius reports null forever,
  // solscan shows "not found"). Detect here and fail the order with a
  // human-readable reason instead of waiting out the 4-minute confirmation
  // timeout.
  const nonceCheck = inspectFirstInstructionIsNonceAdvance(signedBytes)
  if (!nonceCheck.ok) {
    console.error('submit_order_nonce_position_invalid', { id: orderId, ...nonceCheck })
    await markFailed(
      env,
      row,
      'wallet_injected_before_nonce',
      `wallet_injected_instructions_before_nonce_advance: ${nonceCheck.reason}`,
    )
    await incr(env, 'submit_failed_permanent', {
      marketTicker: row.market_ticker,
      error: 'wallet_injected_before_nonce',
    })
    return
  }
  const sigResult = await sendRawTransaction(env, signedBytes)
  if (!sigResult.ok) {
    console.error('submit_order_send_failed', { id: orderId, permanent: sigResult.permanent, error: sigResult.error })
    if (sigResult.permanent) {
      const code = classifyRpcError(sigResult.error)
      await markFailed(env, row, code, sigResult.error)
      await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: code })
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
      `SELECT id, wallet, market_ticker, trigger_price, fill_signature, updated_at,
              signed_tx_enc, signed_tx_iv
         FROM orders
        WHERE id = ? AND status = 'submitting' AND fill_signature IS NOT NULL`,
    )
    .bind(orderId)
    .first<OrderRowConfirmation>()
  if (!row) return  // moved to filled/failed/cancelled by another path

  const status = await getSignatureStatusWithRetry(env, row.fill_signature, 1)
  const ageMs = Date.now() - row.updated_at
  console.log('check_submitted_order', {
    id: orderId,
    signature: row.fill_signature,
    confirmed: status.confirmed,
    error: status.error ?? null,
    ageMs,
  })
  if (status.error) {
    await markFailed(env, row, 'tx_error', status.error)
    await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: 'tx_error' })
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
  // Confirmation neither succeeded nor errored. Before giving up, retry
  // status fetching a few times — a single transient RPC failure shouldn't
  // mark a tx that actually landed as failed. If still unconfirmed after
  // the timeout, treat it as dropped (most often durable-nonce mismatch:
  // runtime rejects pre-inclusion so getSignatureStatuses returns null
  // indefinitely).
  if (ageMs > CONFIRMATION_GIVE_UP_MS) {
    const final = await getSignatureStatusWithRetry(env, row.fill_signature, 3)
    if (final.confirmed) {
      const now = Date.now()
      await env.DB
        .prepare(
          `UPDATE orders SET status = 'filled', fill_price = ?, filled_at = ?, updated_at = ?
            WHERE id = ? AND status = 'submitting'`,
        )
        .bind(row.trigger_price, now, now, row.id)
        .run()
      await audit(env, {
        wallet: row.wallet, orderId: row.id, event: 'order.filled',
        detail: { signature: row.fill_signature, marketTicker: row.market_ticker, lateConfirm: true },
      })
      await incr(env, 'order_filled', { marketTicker: row.market_ticker })
      return
    }
    if (final.error) {
      await markFailed(env, row, 'tx_error', final.error)
      await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: 'tx_error' })
      return
    }
    console.error('check_submitted_order_timeout', { id: orderId, signature: row.fill_signature, ageMs })
    await markFailed(env, row, 'confirmation_timeout', `confirmation_timeout_after_${Math.floor(ageMs / 1000)}s`)
    await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: 'confirmation_timeout' })
    return
  }
  // Tx not confirmed and not yet timed out. Helius's maxRetries: 5 only
  // covers ~150s of automatic rebroadcast; after that, validators no
  // longer see the tx in their mempools and it's effectively dropped.
  // To bridge that gap until CONFIRMATION_GIVE_UP_MS (~240s), re-broadcast
  // the same signed tx ourselves on every alarm cycle. Solana dedups
  // by signature, durable nonces guarantee no double-execution, so this
  // is safe to re-do indefinitely until the tx lands or we time out.
  if (row.signed_tx_enc && row.signed_tx_iv) {
    try {
      const signedBytes = await decrypt(
        { iv: new Uint8Array(row.signed_tx_iv), ciphertext: new Uint8Array(row.signed_tx_enc) },
        env.SIGNED_TX_KEY,
      )
      const rebroadcast = await sendRawTransaction(env, signedBytes)
      console.log('check_submitted_order_rebroadcast', {
        id: orderId,
        signature: row.fill_signature,
        ok: rebroadcast.ok,
        error: rebroadcast.ok ? null : rebroadcast.error,
        ageMs,
      })
    } catch (err) {
      // Non-fatal: a transient decrypt or RPC failure here is fine because
      // the next alarm cycle will retry. The original tx may still land
      // from one of Helius's automatic retries.
      console.error('check_submitted_order_rebroadcast_failed', {
        id: orderId, error: String(err),
      })
    }
  }
  // Otherwise leave alone; next alarm re-checks.
}

// Decode just enough of a serialized v0/legacy tx to verify that the FIRST
// instruction is the System program's advanceNonceAccount. We do NOT pull
// in @solana/web3.js inside the worker; the format is stable and small
// enough to walk by hand. Returns ok=true if the structure matches; ok=false
// with a human-readable reason otherwise.
//
// Wire format (compact-u16 = 1–3 bytes varint):
//   sigCount (cu16) | sigCount * 64 sig bytes |
//   [version_marker?] | header(3) |
//   numStaticAccountKeys (cu16) | N * 32 pubkey bytes |
//   recentBlockhash (32) |
//   numInstructions (cu16) |
//   each instruction: programIdIdx(1) | numAccounts(cu16) | account_idx_bytes |
//                     dataLen(cu16) | data_bytes
//   [v0 only: numAddressTableLookups(cu16) | ...]
//
// For our purposes we only need to reach instruction #0 and check that:
//   (a) its programId resolves to System Program (all-zeros pubkey)
//   (b) its data bytes start with the advanceNonceAccount discriminator (04 00 00 00)
function inspectFirstInstructionIsNonceAdvance(
  bytes: Uint8Array,
): { ok: true } | { ok: false; reason: string; firstProgramId?: string; firstDataHex?: string } {
  try {
    let off = 0
    // Compact-u16 varint reader.
    const readCu16 = (): number => {
      let result = 0
      let shift = 0
      for (let i = 0; i < 3; i++) {
        const b = bytes[off++]
        result |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) return result
        shift += 7
      }
      return result
    }

    const sigCount = readCu16()
    off += sigCount * 64

    // V0 marker: high bit set on first byte after sigs.
    const versionByte = bytes[off]
    const isV0 = (versionByte & 0x80) !== 0
    if (isV0) off += 1

    // Header (3 bytes).
    off += 3

    const numStatic = readCu16()
    const staticOff = off
    off += numStatic * 32

    // recentBlockhash
    off += 32

    const numIxs = readCu16()
    if (numIxs < 1) return { ok: false, reason: 'tx has zero instructions' }

    // First instruction.
    const firstProgramIdx = bytes[off++]
    const firstAccountsLen = readCu16()
    off += firstAccountsLen
    const firstDataLen = readCu16()
    const firstData = bytes.slice(off, off + firstDataLen)

    // Resolve first program id from staticAccountKeys.
    if (firstProgramIdx >= numStatic) {
      return { ok: false, reason: 'first instruction programIdIdx out of range' }
    }
    const firstProgramKey = bytes.slice(staticOff + firstProgramIdx * 32, staticOff + firstProgramIdx * 32 + 32)

    const isAllZero = firstProgramKey.every((b) => b === 0)
    if (!isAllZero) {
      return {
        ok: false,
        reason: 'first instruction is not System program',
        firstProgramId: bytesToHex(firstProgramKey),
        firstDataHex: bytesToHex(firstData),
      }
    }

    // System program advanceNonceAccount discriminator = 0x04 00 00 00.
    const isAdvanceNonce =
      firstData.length >= 4 &&
      firstData[0] === 0x04 && firstData[1] === 0x00 && firstData[2] === 0x00 && firstData[3] === 0x00
    if (!isAdvanceNonce) {
      return {
        ok: false,
        reason: 'first instruction is not System advanceNonceAccount',
        firstDataHex: bytesToHex(firstData),
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `decode_error: ${String(err)}` }
  }
}

function bytesToHex(arr: Uint8Array): string {
  let s = ''
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0')
  return s
}

async function markFailed(
  env: Env,
  row: { id: string; wallet: string; market_ticker?: string },
  code: FailureCode,
  rawDetail: string,
): Promise<void> {
  await markOrderFailed(env, row, code, 'durable_nonce_legacy', rawDetail)
}
