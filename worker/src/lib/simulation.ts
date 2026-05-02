// Pre-broadcast simulation gate.
//
// Before broadcasting an approval-flow swap, the keeper simulates the
// signed tx and parses the post-simulation balances of:
//
//   - the user's outcome-token ATA (legacy SPL Token + Token-2022 candidates)
//   - the executor's USDC ATA
//
// From those balances we decide:
//
//   1. Did the swap actually mint outcome tokens to the user? If not, the
//      tx is a non-swap (e.g. DFlow's `InitUserOrderEscrow` for book-based
//      markets) and we abort with `not_a_swap` instead of leaking funds.
//
//   2. How much USDC remained on the executor after DFlow consumed
//      what it needed? We sweep that residual back to the user in a
//      follow-up instruction so the executor never accumulates user
//      funds.
//
// Detecting the mint's token program (legacy vs Token-2022) without an
// extra RPC: derive both candidate ATAs and check whichever shows up
// non-empty in the simulation response.

import { PublicKey } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'

// SPL Token (and Token-2022) account data layout for the fields we use:
//   bytes 0..32   mint pubkey
//   bytes 32..64  owner pubkey
//   bytes 64..72  amount (u64 LE)
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const TOKEN_ACCOUNT_MIN_LENGTH = 72

// Parse the `amount` field out of an SPL token account. Returns 0n if
// the account is missing or shorter than expected (e.g. the account
// doesn't yet exist at simulation time).
export function parseTokenAccountAmount(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < TOKEN_ACCOUNT_MIN_LENGTH) return 0n
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
    .getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true)
}

// Derive both legacy SPL Token and Token-2022 candidate ATAs for an
// (owner, mint) pair. We don't know the token program a priori without
// an extra RPC; passing both candidates to simulateTransaction lets us
// detect the right one from whichever returns a populated account.
export type AtaCandidates = {
  legacy: PublicKey
  token2022: PublicKey
}

export function deriveAtaCandidates(mint: string, owner: string): AtaCandidates {
  const m = new PublicKey(mint)
  const o = new PublicKey(owner)
  return {
    legacy: getAssociatedTokenAddressSync(m, o, false, TOKEN_PROGRAM_ID),
    token2022: getAssociatedTokenAddressSync(m, o, false, TOKEN_2022_PROGRAM_ID),
  }
}

// Decode a base64 string into a Uint8Array. Worker runtime has atob;
// we keep this in one place so the byte-layout parsers don't have to
// know about transport encoding.
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Pull the token-account amount out of a simulateTransaction account
// entry. Helius returns each entry as { data: [b64, 'base64'], ... } or
// { data: 'b64string', ... } depending on encoding mode; handle both
// shapes so we're not coupled to one specific RPC return convention.
export function readSimulatedTokenAmount(
  entry: { data: string | [string, string] } | null | undefined,
): bigint {
  if (!entry || !entry.data) return 0n
  const b64 = Array.isArray(entry.data) ? entry.data[0] : entry.data
  if (typeof b64 !== 'string') return 0n
  return parseTokenAccountAmount(decodeBase64(b64))
}
