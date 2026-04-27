// Read a user's outcome-token balance for a single mint. Used by stop-loss
// and take-profit placement to validate the user actually owns enough
// shares to sell, and to compute share count from a USDC-denominated
// trigger amount.
//
// We resolve the Associated Token Account (ATA) with the standard
// Token Program seeds — DFlow's outcome tokens are SPL tokens, so the
// classic ATA derivation applies.

import {
  Connection,
  PublicKey,
} from '@solana/web3.js'

// Hard-coded program IDs — these are part of the Solana protocol surface
// and never change. Avoid pulling in @solana/spl-token (~50KB) for two
// constants and two PDA derivations.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

const connectionCache = new Map()
function connectionFor(rpcUrl) {
  let c = connectionCache.get(rpcUrl)
  if (!c) {
    c = new Connection(rpcUrl, 'confirmed')
    connectionCache.set(rpcUrl, c)
  }
  return c
}

function deriveAtaAddress(ownerPubkey, mintPubkey) {
  const owner = typeof ownerPubkey === 'string' ? new PublicKey(ownerPubkey) : ownerPubkey
  const mint = typeof mintPubkey === 'string' ? new PublicKey(mintPubkey) : mintPubkey
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

// Returns the user's balance in human units (whole shares, decimal).
// Returns 0 when the ATA doesn't exist yet — the user has no position.
export async function getOutcomeBalance({ rpcUrl, owner, mint }) {
  const conn = connectionFor(rpcUrl)
  const ata = deriveAtaAddress(owner, mint)
  try {
    const result = await conn.getTokenAccountBalance(ata, 'confirmed')
    return parseFloat(result?.value?.uiAmountString ?? '0')
  } catch (err) {
    // Account-not-found is the common case when the user hasn't traded
    // this market yet. RPC throws rather than returning 0 in that
    // scenario; treat any read error as "no position".
    if (String(err).includes('could not find account')) return 0
    if (String(err).includes('Invalid account owner')) return 0
    throw err
  }
}
