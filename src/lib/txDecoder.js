// Decode a DFlow-returned transaction and assert that every instruction
// targets a program we expect. If a compromised DFlow server substitutes
// a drain-wallet instruction, this catches it before the wallet modal
// opens.
//
// Returns { ok: true, summary: [...] } on success, or { ok: false, error } on reject.

import {
  VersionedTransaction,
  Transaction,
  PublicKey,
} from '@solana/web3.js'
import { USDC_MINT, SPL_TOKEN_PROGRAM } from '../config/env'

// Program IDs allowed inside a DFlow order tx. Extend when DFlow publishes
// an authoritative list.
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
// DFlow's Prediction Markets program — the on-chain router that opens /
// closes outcome-token positions. Mainnet address; DFlow doesn't publish
// a versioned constant, so we pin it here. Same string lives in
// simulationErrors.js for error humanization.
const DFLOW_PREDICT_PROGRAM = 'pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb'

// DFlow router program IDs. Real values should come from DFlow's docs
// and can be overridden via VITE_DFLOW_ALLOWED_PROGRAMS (comma-separated).
function getAllowedPrograms() {
  const base = [
    SYSTEM_PROGRAM,
    SPL_TOKEN_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    ATA_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    MEMO_PROGRAM,
    DFLOW_PREDICT_PROGRAM,
  ]
  const extra = (import.meta.env?.VITE_DFLOW_ALLOWED_PROGRAMS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  return new Set([...base, ...extra])
}

// Accepts the raw tx bytes DFlow sent us (base64 string or Uint8Array).
export function decodeDflowTransaction(input) {
  const bytes = typeof input === 'string'
    ? Uint8Array.from(atob(input), c => c.charCodeAt(0))
    : input

  // Try versioned first, fall back to legacy.
  let tx
  try {
    tx = VersionedTransaction.deserialize(bytes)
  } catch {
    try {
      tx = Transaction.from(bytes)
    } catch (err) {
      return { ok: false, error: `Could not decode transaction: ${err.message}` }
    }
  }
  return { ok: true, tx }
}

function instructionsOf(tx) {
  if (tx?.message?.compiledInstructions) {
    const keys = tx.message.staticAccountKeys
    return tx.message.compiledInstructions.map(ix => ({
      programId: keys[ix.programIdIndex].toBase58(),
      accountCount: ix.accountKeyIndexes.length,
      dataLen: ix.data.length,
    }))
  }
  if (tx?.instructions) {
    return tx.instructions.map(ix => ({
      programId: ix.programId.toBase58(),
      accountCount: ix.keys.length,
      dataLen: ix.data.length,
    }))
  }
  return []
}

// Returns { ok, summary, offending? }. `ok: false` if any instruction
// targets a program not in the allowlist.
export function assertAllowedPrograms(tx) {
  const allowed = getAllowedPrograms()
  const ixs = instructionsOf(tx)
  if (ixs.length === 0) {
    return { ok: false, error: 'Transaction has no instructions' }
  }
  const offending = ixs.find(ix => !allowed.has(ix.programId))
  if (offending) {
    return {
      ok: false,
      error: `Transaction targets unexpected program: ${offending.programId}`,
      summary: ixs,
    }
  }
  return { ok: true, summary: ixs }
}

// Guardrail: cap transaction payload size. Solana's hard limit is 1232 bytes;
// give some headroom but reject anything that looks like it's trying to smuggle
// in a large payload.
export const MAX_TX_SIZE = 1500

export function validateTxPayload(input) {
  if (input == null) return { ok: false, error: 'Empty transaction payload' }
  const length = typeof input === 'string' ? input.length : input.byteLength
  if (length === 0) return { ok: false, error: 'Empty transaction payload' }
  if (length > MAX_TX_SIZE * 2) {
    return { ok: false, error: `Transaction payload too large (${length} bytes)` }
  }
  return { ok: true }
}

export { USDC_MINT }
