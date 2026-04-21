import { describe, it, expect } from 'vitest'
import { validateTxPayload, MAX_TX_SIZE } from './txDecoder'

describe('validateTxPayload', () => {
  it('rejects null/undefined/empty', () => {
    expect(validateTxPayload(null).ok).toBe(false)
    expect(validateTxPayload(undefined).ok).toBe(false)
    expect(validateTxPayload('').ok).toBe(false)
    expect(validateTxPayload(new Uint8Array(0)).ok).toBe(false)
  })

  it('rejects payloads larger than 2× MAX_TX_SIZE', () => {
    const huge = 'a'.repeat(MAX_TX_SIZE * 2 + 1)
    expect(validateTxPayload(huge).ok).toBe(false)
  })

  it('accepts sensibly-sized bytes and strings', () => {
    expect(validateTxPayload(new Uint8Array(500)).ok).toBe(true)
    expect(validateTxPayload('a'.repeat(500)).ok).toBe(true)
  })
})
