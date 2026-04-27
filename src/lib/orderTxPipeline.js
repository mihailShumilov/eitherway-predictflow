// Single-source-of-truth pipeline for fetching, validating, signing, and
// (optionally) broadcasting a DFlow swap transaction.
//
// Before this consolidation: useTradeSubmit, useConditionalOrders,
// useDCA, and useKeeperLimitOrder each had their own slightly-different
// copy of the same sequence. Three of them were drifting in real bugs:
//
//   - DCA was passing raw bytes to provider.signTransaction (caller bug).
//   - DCA never broadcast the signed tx (caller bug).
//   - useTradeSubmit included preflight; useDCA didn't.
//   - useKeeperLimitOrder signs offline (no broadcast) by design.
//
// The pipeline below makes the differences explicit options so each caller
// declares what it actually wants — `preflight: true|false`,
// `broadcast: 'send' | 'sign-only'` — and there is exactly one place to
// fix the next protocol-level bug.

import { fetchWithRetry, generateIdempotencyKey } from './http'
import {
  decodeDflowTransaction,
  assertAllowedPrograms,
  validateTxPayload,
} from './txDecoder'
import { preflightTransaction } from './solanaPreflight'
import { safeErrorMessage } from './errorMessage'
import { classifyOrderResponse } from './dflowErrors'
import { formatSimulationError } from './simulationErrors'
import { DFLOW_ORDER_URL } from '../config/env'

/**
 * Build, validate, decode, optionally preflight, and optionally sign+send
 * a DFlow /order transaction.
 *
 * @param {object} opts
 * @param {string} opts.inputMint
 * @param {string} opts.outputMint
 * @param {number} opts.amountLamports        - integer, scaled to 6 decimals for USDC / outcome tokens
 * @param {string} opts.userPublicKey
 * @param {string} [opts.idempotencyPrefix]   - short tag like 'mkt' / 'cond' / 'dca' / 'lim'
 * @param {object} [opts.provider]            - wallet provider (signTransaction / signAndSendTransaction)
 * @param {boolean} [opts.preflight]          - run simulateTransaction before signing (default true)
 * @param {'send'|'sign-only'} [opts.broadcast] - 'send' calls signAndSendTransaction; 'sign-only' returns the signed tx unsent (keeper flow)
 *
 * @returns {Promise<
 *     | { ok: true, decodedTx, signedTx?, signature?: string, txSigned: boolean }
 *     | { ok: false, retryable: boolean, error: string, simDetails?: string, simLogs?: string[] }
 *  >}
 */
export async function runOrderPipeline(opts) {
  const {
    inputMint, outputMint, amountLamports, userPublicKey,
    idempotencyPrefix = 'ord',
    provider, preflight = true, broadcast = 'send',
  } = opts

  if (!provider) return { ok: false, retryable: true, error: 'No wallet provider' }
  if (!userPublicKey) return { ok: false, retryable: true, error: 'Wallet not connected' }
  if (!inputMint || !outputMint) return { ok: false, retryable: false, error: 'Missing input or output mint' }
  if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
    return { ok: false, retryable: false, error: 'Invalid amount' }
  }

  // 1. Fetch DFlow /order
  let data
  try {
    const url = `${DFLOW_ORDER_URL}?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountLamports}&userPublicKey=${userPublicKey}`
    const res = await fetchWithRetry(url, {
      headers: { 'X-Idempotency-Key': generateIdempotencyKey(idempotencyPrefix) },
    }, { retries: 1, timeoutMs: 8000 })
    if (!res.ok) {
      // Run the DFlow-specific classifier so callers can detect KYC /
      // compliance rejections and route them to the right UI (KYC modal,
      // region-blocked banner, etc.) instead of a generic error toast.
      const cl = await classifyOrderResponse(res)
      const retryable = res.status >= 500
      return {
        ok: false,
        retryable,
        error: cl.message,
        kind: cl.kind,        // 'kyc' | 'compliance' | 'other'
        status: cl.status,
      }
    }
    data = await res.json()
  } catch (err) {
    return { ok: false, retryable: true, error: safeErrorMessage(err, 'Order request failed') }
  }

  // 2. Validate payload + decode
  const payloadCheck = validateTxPayload(data?.transaction)
  if (!payloadCheck.ok) return { ok: false, retryable: false, error: payloadCheck.error }
  if (!data.transaction) return { ok: false, retryable: false, error: 'Order API returned no transaction' }
  const decoded = decodeDflowTransaction(data.transaction)
  if (!decoded.ok) return { ok: false, retryable: false, error: decoded.error }

  // 3. Whitelist program ids — must be done BEFORE the wallet popup so
  //    a compromised DFlow can't slip a drain-wallet instruction past us.
  const whitelist = assertAllowedPrograms(decoded.tx)
  if (!whitelist.ok) return { ok: false, retryable: false, error: whitelist.error }

  // 4. Preflight on a Solana RPC. Skipped by callers that intentionally
  //    don't broadcast (e.g. keeper signs offline; preflight there would
  //    waste an RPC call on a tx the user's nonce will validate later).
  if (preflight) {
    const txBytes = typeof data.transaction === 'string'
      ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
      : data.transaction
    const pf = await preflightTransaction(txBytes)
    if (!pf.ok) {
      if (pf.unreachable) {
        return { ok: false, retryable: true, error: 'Could not verify order with Solana RPC. Please try again.' }
      }
      // Format the simulation logs into a user-readable message + raw
      // logs for the "show details" expander in ResultBanner.
      const formatted = formatSimulationError({
        error: pf.error,
        logs: pf.logs,
        summary: whitelist.summary,
      })
      return {
        ok: false,
        retryable: false,
        error: formatted.message,
        simDetails: formatted.details,
        simLogs: formatted.logs,
        simRaw: pf.error,
      }
    }
  }

  // 5. Sign (and optionally broadcast).
  if (broadcast === 'sign-only') {
    // Caller will compose with durable nonce or otherwise post-process
    // before broadcasting. Just return the decoded tx; the caller signs
    // its own (possibly modified) version.
    return { ok: true, decodedTx: decoded.tx, txSigned: false }
  }

  try {
    if (typeof provider.signAndSendTransaction === 'function') {
      const sent = await provider.signAndSendTransaction(decoded.tx)
      const signature = sent?.signature || sent?.publicKey || 'signed'
      return { ok: true, decodedTx: decoded.tx, signature, txSigned: true }
    }
    if (typeof provider.signTransaction === 'function') {
      // Older adapters without combined sign+send. Caller is responsible
      // for broadcasting the signed bytes (via Connection.sendRawTransaction
      // or similar). Returning the signed tx but no signature — caller
      // computes/broadcasts.
      const signedTx = await provider.signTransaction(decoded.tx)
      const sig = signedTx?.signatures?.[0]
      const sigBytes = sig?.signature || (sig instanceof Uint8Array ? sig : null)
      const signature = sigBytes
        ? Array.from(sigBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
        : 'signed'
      return { ok: true, decodedTx: decoded.tx, signedTx, signature, txSigned: true }
    }
    return { ok: false, retryable: false, error: 'Wallet does not support signing' }
  } catch (err) {
    return { ok: false, retryable: true, error: safeErrorMessage(err, 'Sign failed') }
  }
}
