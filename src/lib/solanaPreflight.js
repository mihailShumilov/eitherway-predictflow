// Transaction preflight: ask a Solana RPC to simulateTransaction on a
// base64-encoded message before asking the user to sign. Surfaces obvious
// errors (account-not-found, insufficient-funds, program-error) *before*
// the wallet modal opens, so the user doesn't sign something that was
// always going to fail.
//
// Returns:
//   { ok: true, logs }                — simulation passed
//   { ok: false, error, logs }        — simulation returned an error
//   { ok: false, unreachable: true }  — every RPC endpoint failed
//
// IMPORTANT: we do NOT return `ok: true` when all RPCs are unreachable.
// Silent passthrough would let a compromised DFlow server slip malicious
// txns through when the RPC provider has an outage. The caller decides
// whether to block or prompt the user to override.

import { SOLANA_RPC_ENDPOINTS } from '../config/env'

function toBase64(bytes) {
  if (typeof bytes === 'string') return bytes
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

async function simulateOn(endpoint, txBase64) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [
        txBase64,
        {
          encoding: 'base64',
          // The tx isn't signed yet — skip signature verification so
          // simulation runs. `replaceRecentBlockhash` avoids stale-hash
          // failures; `commitment: 'processed'` is the fastest tier.
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'processed',
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`RPC ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'RPC error')
  return data.result
}

function summarizeErr(err) {
  if (!err) return null
  if (typeof err === 'string') return err
  if (err.InstructionError) {
    const [idx, detail] = err.InstructionError
    const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return `Instruction ${idx} failed: ${detailStr}`
  }
  return JSON.stringify(err)
}

export async function preflightTransaction(txBytesOrBase64) {
  const txBase64 = toBase64(txBytesOrBase64)
  let lastErr
  for (const endpoint of SOLANA_RPC_ENDPOINTS) {
    try {
      const result = await simulateOn(endpoint, txBase64)
      const errDetail = summarizeErr(result?.value?.err)
      if (errDetail) {
        return { ok: false, error: errDetail, logs: result.value.logs || [] }
      }
      return { ok: true, logs: result?.value?.logs || [] }
    } catch (err) {
      lastErr = err
    }
  }
  return {
    ok: false,
    unreachable: true,
    error: `Preflight unavailable (${lastErr?.message || 'unknown'})`,
  }
}
