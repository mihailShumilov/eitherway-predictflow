import { describe, it, expect } from 'vitest'
import { validateTxPayload, MAX_TX_SIZE } from './txDecoder'

describe('validateTxPayload', () => {
  it('rejects null/undefined/empty', () => {
    expect(validateTxPayload(null).ok).toBe(false)
    expect(validateTxPayload(undefined).ok).toBe(false)
    expect(validateTxPayload('').ok).toBe(false)
    expect(validateTxPayload(new Uint8Array(0)).ok).toBe(false)
  })

  it('rejects raw byte arrays larger than MAX_TX_SIZE', () => {
    expect(validateTxPayload(new Uint8Array(MAX_TX_SIZE + 1)).ok).toBe(false)
  })

  it('rejects a base64 string that decodes to more than MAX_TX_SIZE bytes', () => {
    // ~2400 base64 chars decode to ~1800 bytes — over the 1500 cap. The old
    // guard (string length vs MAX_TX_SIZE*2 = 3000) wrongly accepted this.
    const oversizedBase64 = 'a'.repeat(2400)
    expect(oversizedBase64.length).toBeLessThanOrEqual(MAX_TX_SIZE * 2)
    expect(validateTxPayload(oversizedBase64).ok).toBe(false)
  })

  it('accepts sensibly-sized bytes and strings', () => {
    expect(validateTxPayload(new Uint8Array(500)).ok).toBe(true)
    expect(validateTxPayload('a'.repeat(500)).ok).toBe(true)
    // A real Solana tx (max 1232 bytes) base64-encodes to ~1644 chars.
    expect(validateTxPayload('a'.repeat(1644)).ok).toBe(true)
  })
})
