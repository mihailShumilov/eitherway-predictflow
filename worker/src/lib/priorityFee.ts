// Compute-budget priority-fee enforcement.
//
// DFlow's /order response usually embeds its own ComputeBudget
// SetComputeUnitPrice. That value can be low under mainnet congestion,
// causing the broadcast to be dropped from validator mempools and the
// keeper to time out at confirmation. This module enforces a floor so
// a low DFlow quote can't drag us below what's needed to land.
//
// SetComputeUnitLimit and any other compute-budget instruction types are
// passed through untouched — DFlow's per-route CU sizing should be
// preserved; we only enforce a price floor.

import { ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js'

// Compute-budget instruction discriminator for SetComputeUnitPrice.
// Layout: [3, ...u64 LE microLamports]
const SET_COMPUTE_UNIT_PRICE = 3

// Returns the SetComputeUnitPrice value in microlamports, or null if the
// instruction is from a different program or a different CB variant.
export function parseSetComputeUnitPrice(ix: TransactionInstruction): bigint | null {
  if (!ix.programId.equals(ComputeBudgetProgram.programId)) return null
  if (ix.data.length < 9) return null
  if (ix.data[0] !== SET_COMPUTE_UNIT_PRICE) return null
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength)
  return view.getBigUint64(1, true)
}

// Returns the first SetComputeUnitPrice value found in a list of
// compute-budget instructions, or null if none is present. A list should
// contain at most one SetComputeUnitPrice in practice; the first wins.
export function extractComputeUnitPrice(cbIxs: TransactionInstruction[]): bigint | null {
  for (const ix of cbIxs) {
    const v = parseSetComputeUnitPrice(ix)
    if (v !== null) return v
  }
  return null
}

// Build a SetComputeUnitPrice instruction with explicit byte layout.
// Avoids @solana/web3.js's BufferLayout-based helper, which is strict
// about Buffer vs Uint8Array under vitest in Node and breaks tests
// without a polyfill. Layout matches `parseSetComputeUnitPrice` above.
function buildSetComputeUnitPrice(microLamports: number): TransactionInstruction {
  const data = new Uint8Array(9)
  data[0] = SET_COMPUTE_UNIT_PRICE
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true)
  return new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: Buffer.from(data),
  })
}

// Walk a list of compute-budget instructions and enforce a floor on
// SetComputeUnitPrice. Replace one whose existing value is below the
// floor; append one if no SetComputeUnitPrice is present at all.
//
// Other compute-budget instructions (SetComputeUnitLimit, RequestHeapFrame,
// etc.) are returned unchanged in their original order so DFlow's CU
// sizing and any heap requests are preserved.
export function applyComputeUnitPriceFloor(
  cbIxs: TransactionInstruction[],
  floorMicroLamports: number,
): TransactionInstruction[] {
  const floor = BigInt(floorMicroLamports)
  let foundPrice = false
  const out = cbIxs.map((ix) => {
    const existing = parseSetComputeUnitPrice(ix)
    if (existing === null) return ix
    foundPrice = true
    if (existing >= floor) return ix
    return buildSetComputeUnitPrice(floorMicroLamports)
  })
  if (!foundPrice) {
    out.push(buildSetComputeUnitPrice(floorMicroLamports))
  }
  return out
}
