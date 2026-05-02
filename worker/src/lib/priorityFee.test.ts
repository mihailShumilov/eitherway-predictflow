import { describe, it, expect } from 'vitest'
import {
  ComputeBudgetProgram, PublicKey, TransactionInstruction,
} from '@solana/web3.js'

import {
  applyComputeUnitPriceFloor, extractComputeUnitPrice, parseSetComputeUnitPrice,
} from './priorityFee'

const FLOOR = 250_000

// Manual fixture builders. We construct the on-the-wire byte layout
// directly to avoid @solana/web3.js's BufferLayout helpers, which fail
// under vitest in Node when Buffer/Uint8Array conventions diverge.
//
// Layouts:
//   SetComputeUnitPrice: [3, ...u64 LE microLamports]    (9 bytes)
//   SetComputeUnitLimit: [2, ...u32 LE units]            (5 bytes)
//   RequestHeapFrame:    [1, ...u32 LE bytes]            (5 bytes)
function setCUPrice(microLamports: number): TransactionInstruction {
  const data = new Uint8Array(9)
  data[0] = 3
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true)
  return new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: Buffer.from(data),
  })
}

function setCULimit(units: number): TransactionInstruction {
  const data = new Uint8Array(5)
  data[0] = 2
  new DataView(data.buffer).setUint32(1, units, true)
  return new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: Buffer.from(data),
  })
}

function requestHeapFrame(bytes: number): TransactionInstruction {
  const data = new Uint8Array(5)
  data[0] = 1
  new DataView(data.buffer).setUint32(1, bytes, true)
  return new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: Buffer.from(data),
  })
}

function memoIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [],
    data: Buffer.from('hello', 'utf8'),
  })
}

describe('parseSetComputeUnitPrice', () => {
  it('returns the price when given a SetComputeUnitPrice ix', () => {
    expect(parseSetComputeUnitPrice(setCUPrice(12345))).toBe(12345n)
  })

  it('returns null for SetComputeUnitLimit', () => {
    expect(parseSetComputeUnitPrice(setCULimit(200_000))).toBeNull()
  })

  it('returns null for non-CB programs', () => {
    expect(parseSetComputeUnitPrice(memoIx())).toBeNull()
  })

  it('handles large u64 values without precision loss', () => {
    const big = 4_294_967_296 // > u32 max, well within u64
    expect(parseSetComputeUnitPrice(setCUPrice(big))).toBe(BigInt(big))
  })
})

describe('extractComputeUnitPrice', () => {
  it('returns null when no SetComputeUnitPrice is present', () => {
    expect(extractComputeUnitPrice([setCULimit(200_000), memoIx()])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(extractComputeUnitPrice([])).toBeNull()
  })

  it('returns the price when one is present', () => {
    expect(extractComputeUnitPrice([setCULimit(200_000), setCUPrice(7_777)])).toBe(7_777n)
  })

  it('returns the first SetComputeUnitPrice when multiple are present', () => {
    const out = extractComputeUnitPrice([setCUPrice(111), setCUPrice(222)])
    expect(out).toBe(111n)
  })
})

describe('applyComputeUnitPriceFloor', () => {
  it('replaces a SetComputeUnitPrice that is below the floor', () => {
    const cbIxs = [setCULimit(200_000), setCUPrice(1_000)]
    const out = applyComputeUnitPriceFloor(cbIxs, FLOOR)
    expect(out).toHaveLength(2)
    expect(parseSetComputeUnitPrice(out[0])).toBeNull() // CU limit preserved
    expect(parseSetComputeUnitPrice(out[1])).toBe(BigInt(FLOOR))
  })

  it('preserves a SetComputeUnitPrice at the floor exactly', () => {
    const cbIxs = [setCUPrice(FLOOR)]
    const out = applyComputeUnitPriceFloor(cbIxs, FLOOR)
    expect(parseSetComputeUnitPrice(out[0])).toBe(BigInt(FLOOR))
    // Same instance — not rewritten.
    expect(out[0]).toBe(cbIxs[0])
  })

  it('preserves a SetComputeUnitPrice that is above the floor', () => {
    const cbIxs = [setCUPrice(FLOOR * 2)]
    const out = applyComputeUnitPriceFloor(cbIxs, FLOOR)
    expect(parseSetComputeUnitPrice(out[0])).toBe(BigInt(FLOOR * 2))
    expect(out[0]).toBe(cbIxs[0])
  })

  it('appends a SetComputeUnitPrice when none is present', () => {
    const cbIxs = [setCULimit(300_000)]
    const out = applyComputeUnitPriceFloor(cbIxs, FLOOR)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(cbIxs[0]) // SetCULimit preserved
    expect(parseSetComputeUnitPrice(out[1])).toBe(BigInt(FLOOR))
  })

  it('preserves order and identity of unrelated CB instructions', () => {
    const limit = setCULimit(300_000)
    const heap = requestHeapFrame(64 * 1024)
    const lowPrice = setCUPrice(100)
    const out = applyComputeUnitPriceFloor([limit, heap, lowPrice], FLOOR)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(limit)
    expect(out[1]).toBe(heap)
    expect(parseSetComputeUnitPrice(out[2])).toBe(BigInt(FLOOR))
  })

  it('returns just the appended price when given an empty list', () => {
    const out = applyComputeUnitPriceFloor([], FLOOR)
    expect(out).toHaveLength(1)
    expect(parseSetComputeUnitPrice(out[0])).toBe(BigInt(FLOOR))
  })
})
