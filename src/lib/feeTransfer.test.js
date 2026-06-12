import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { createSplTransferInstruction, TOKEN_PROGRAM_ID } from './feeTransfer'

// Three distinct, well-formed pubkeys (construction works under jsdom; only PDA
// derivation is broken there, which this path doesn't use).
const SOURCE = new PublicKey('So11111111111111111111111111111111111111112')
const DEST = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const AUTH = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

function decodeAmount(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getBigUint64(1, true) // skip the 1-byte discriminator, u64 LE
}

describe('createSplTransferInstruction', () => {
  it('uses the SPL Token Transfer discriminator (3)', () => {
    const ix = createSplTransferInstruction({ source: SOURCE, destination: DEST, authority: AUTH, amountLamports: 1 })
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true)
    expect(ix.data[0]).toBe(3)
    expect(ix.data).toHaveLength(9)
  })

  it('encodes the amount as a little-endian u64', () => {
    for (const amount of [0, 1, 1_000_000, 123_456_789, Number.MAX_SAFE_INTEGER]) {
      const ix = createSplTransferInstruction({ source: SOURCE, destination: DEST, authority: AUTH, amountLamports: amount })
      expect(decodeAmount(ix.data)).toBe(BigInt(amount))
    }
  })

  it('marks source/destination writable and authority as the signer', () => {
    const ix = createSplTransferInstruction({ source: SOURCE, destination: DEST, authority: AUTH, amountLamports: 5 })
    const [src, dst, auth] = ix.keys
    expect(src.pubkey.equals(SOURCE)).toBe(true)
    expect(src.isWritable).toBe(true)
    expect(dst.pubkey.equals(DEST)).toBe(true)
    expect(dst.isWritable).toBe(true)
    expect(auth.pubkey.equals(AUTH)).toBe(true)
    expect(auth.isSigner).toBe(true)
    expect(auth.isWritable).toBe(false)
  })
})
