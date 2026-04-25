// Build and send SPL Token Transfer instructions without pulling in
// `@solana/spl-token`. We need just two primitives — derive the associated
// token address (ATA) for a wallet/mint, and build a Transfer instruction.
//
// Both are stable, well-documented layouts (Token program uses a 1-byte
// discriminator + u64 LE for Transfer; ATA derivation uses standard PDA seeds).
// Inlining keeps the bundle small and avoids forcing users to install the
// extra package during a hackathon.

import {
  PublicKey,
  TransactionInstruction,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import { SOLANA_RPC_ENDPOINTS, USDC_MINT, SPL_TOKEN_PROGRAM } from '../config/env'

export const TOKEN_PROGRAM_ID = new PublicKey(SPL_TOKEN_PROGRAM)
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
)

// Derive the associated token address for an (owner, mint) pair.
export function getAssociatedTokenAddress(mint, owner) {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )
  return address
}

// SPL Token Transfer: discriminator 3, then u64 LE amount.
function encodeTransferData(amountLamports) {
  const data = new Uint8Array(9)
  data[0] = 3
  const view = new DataView(data.buffer)
  view.setBigUint64(1, BigInt(amountLamports), true)
  return data
}

export function createSplTransferInstruction({
  source,
  destination,
  authority,
  amountLamports,
}) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: encodeTransferData(amountLamports),
  })
}

// Associated Token Account create — needed when the destination wallet has
// never held this mint. Idempotent variant (1) does nothing if the ATA
// already exists, so it's safe to always include.
export function createAssociatedTokenAccountIdempotentInstruction({
  payer,
  associatedToken,
  owner,
  mint,
}) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  })
}

// Try each RPC endpoint until one returns a usable response. The codebase
// already follows this pattern in usePortfolio — replicate it here so this
// helper has no external dependency on a Connection singleton.
async function rpcCall(method, params) {
  let lastErr = null
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!res.ok) { lastErr = new Error(`RPC ${url} ${res.status}`); continue }
      const json = await res.json()
      if (json.error) { lastErr = new Error(json.error.message); continue }
      return { url, result: json.result }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('All RPC endpoints failed')
}

export async function getLatestBlockhash() {
  const { result } = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const value = result?.value || result
  if (!value?.blockhash) throw new Error('Could not fetch recent blockhash')
  return {
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
  }
}

// Build a self-contained legacy Transaction that pays the fee transfer(s).
// Returns { tx, summary } — summary is a structured view used by callers
// for telemetry or display.
export async function buildFeeTransferTransaction({
  fromPubkey,
  mint,
  transfers,
}) {
  const owner = new PublicKey(fromPubkey)
  const mintPk = new PublicKey(mint)
  const sourceAta = getAssociatedTokenAddress(mintPk, owner)

  const tx = new Transaction()
  // Bump compute budget down — these transfers are tiny so we don't need
  // the default 200K CU and a small explicit limit lowers priority fees.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))

  const summary = []
  for (const t of transfers) {
    if (!t || !(t.amountLamports > 0) || !t.toPubkey) continue
    const dest = new PublicKey(t.toPubkey)
    const destAta = getAssociatedTokenAddress(mintPk, dest)

    tx.add(createAssociatedTokenAccountIdempotentInstruction({
      payer: owner,
      associatedToken: destAta,
      owner: dest,
      mint: mintPk,
    }))
    tx.add(createSplTransferInstruction({
      source: sourceAta,
      destination: destAta,
      authority: owner,
      amountLamports: t.amountLamports,
    }))
    summary.push({ to: t.toPubkey, label: t.label, amountLamports: t.amountLamports })
  }

  if (summary.length === 0) return null

  const { blockhash, lastValidBlockHeight } = await getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = owner

  return { tx, summary }
}

export const USDC_MINT_PK = new PublicKey(USDC_MINT)
