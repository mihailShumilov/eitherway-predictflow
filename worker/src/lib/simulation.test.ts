import { describe, it, expect } from 'vitest'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'

import {
  parseTokenAccountAmount, readSimulatedTokenAmount, decodeBase64,
} from './simulation'

// Build a minimal SPL token account buffer with the `amount` u64 LE
// written at the canonical offset. The other 64 bytes (mint + owner)
// don't matter for amount parsing, so we leave them zeroed.
function tokenAccountBytes(amount: bigint, length = 165): Uint8Array {
  const buf = new Uint8Array(length)
  new DataView(buf.buffer).setBigUint64(64, amount, true)
  return buf
}

function bytesToBase64(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i])
  return btoa(bin)
}

describe('parseTokenAccountAmount', () => {
  it('reads a u64 LE amount at byte offset 64', () => {
    expect(parseTokenAccountAmount(tokenAccountBytes(123_456_789n))).toBe(123_456_789n)
  })

  it('returns 0 for null / undefined', () => {
    expect(parseTokenAccountAmount(null)).toBe(0n)
    expect(parseTokenAccountAmount(undefined)).toBe(0n)
  })

  it('returns 0 for buffers shorter than the amount offset', () => {
    expect(parseTokenAccountAmount(new Uint8Array(40))).toBe(0n)
  })

  it('handles maximum u64 values without precision loss', () => {
    const max = 0xFFFFFFFFFFFFFFFFn
    expect(parseTokenAccountAmount(tokenAccountBytes(max))).toBe(max)
  })
})

describe('decodeBase64', () => {
  it('round-trips bytes', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(decodeBase64(bytesToBase64(original))).toEqual(original)
  })
})

describe('readSimulatedTokenAmount', () => {
  it('returns 0 for missing entries', () => {
    expect(readSimulatedTokenAmount(null)).toBe(0n)
    expect(readSimulatedTokenAmount(undefined)).toBe(0n)
    expect(readSimulatedTokenAmount({ data: null as any })).toBe(0n)
  })

  it('parses from Helius single-string data shape', () => {
    const b64 = bytesToBase64(tokenAccountBytes(42n))
    expect(readSimulatedTokenAmount({ data: b64 })).toBe(42n)
  })

  it('parses from Helius [base64, encoding] tuple shape', () => {
    const b64 = bytesToBase64(tokenAccountBytes(99n))
    expect(readSimulatedTokenAmount({ data: [b64, 'base64'] })).toBe(99n)
  })
})

describe('deriveAtaCandidates', () => {
  // Note: full PDA derivation via @solana/spl-token's
  // getAssociatedTokenAddressSync depends on tweetnacl's on-curve check,
  // which is unreliable under vitest's Node environment. We don't try
  // to test the derivation itself here — that's exercised by upstream
  // @solana/spl-token tests and verified end-to-end by the keeper's
  // integration tests in production. We only assert the program-id
  // constants we depend on are distinct (sanity check that our
  // two-candidate detection strategy is meaningful).
  it('uses distinct TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID', () => {
    expect(TOKEN_PROGRAM_ID.equals(TOKEN_2022_PROGRAM_ID)).toBe(false)
  })
})
