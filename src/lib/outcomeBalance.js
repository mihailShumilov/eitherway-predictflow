// Read a user's outcome-token balance for a single mint. Used by stop-loss
// and take-profit placement to validate the user actually owns enough
// shares to sell, and to compute share count from a USDC-denominated
// trigger amount.
//
// DFlow's prediction-market outcome mints are issued under Token-2022
// (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb), so the Associated Token
// Account is derived with the Token-2022 program in the PDA seeds, not the
// classic SPL Token program. We try Token-2022 first and fall back to the
// classic program so the helper also works for plain SPL mints (e.g. USDC).

import {
  Connection,
  PublicKey,
} from '@solana/web3.js'

// Hard-coded program IDs — these are part of the Solana protocol surface
// and never change. Avoid pulling in @solana/spl-token (~50KB) for two
// constants and two PDA derivations.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

// Outcome tokens are Token-2022; check that program first so the common
// path resolves in a single RPC call.
const ATA_PROGRAM_CANDIDATES = [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]

const connectionCache = new Map()
function connectionFor(rpcUrl) {
  let c = connectionCache.get(rpcUrl)
  if (!c) {
    c = new Connection(rpcUrl, 'confirmed')
    connectionCache.set(rpcUrl, c)
  }
  return c
}

function deriveAtaAddress(ownerPubkey, mintPubkey, tokenProgramId) {
  const owner = typeof ownerPubkey === 'string' ? new PublicKey(ownerPubkey) : ownerPubkey
  const mint = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

function isAccountMissing(err) {
  const msg = String(err)
  return msg.includes('could not find account') || msg.includes('Invalid account owner')
}

// Returns the user's balance in human units (whole shares, decimal).
// Returns 0 when no token account exists yet — the user has no position.
export async function getOutcomeBalance({ rpcUrl, owner, mint }) {
  const conn = connectionFor(rpcUrl)
  let lastErr = null
  for (const programId of ATA_PROGRAM_CANDIDATES) {
    const ata = deriveAtaAddress(owner, mint, programId)
    try {
      const result = await conn.getTokenAccountBalance(ata, 'confirmed')
      return parseFloat(result?.value?.uiAmountString ?? '0')
    } catch (err) {
      // Account-not-found is the common case when the user holds the token
      // under the other program (or hasn't traded this market yet). Try the
      // next candidate; only surface a non-missing error after both fail.
      if (isAccountMissing(err)) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  // Neither program's ATA exists → the user holds no position.
  if (lastErr) return 0
  return 0
}
