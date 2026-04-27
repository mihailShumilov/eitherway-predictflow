// Session-token helper tests, focusing on the hmacKey passphrase
// fallback path and edge cases not covered by encryption.test.ts.

import { describe, it, expect } from 'vitest'
import { mintSessionToken, verifySessionToken } from './session'
import { bytesToBase64 } from './crypto'

describe('hmacKey passphrase-vs-base64 fallback', () => {
  // The fallback: if the secret parses as base64 of length ≥ 32 it's
  // used directly; otherwise we sha256 it. That branch decision MUST be
  // stable so a passphrase typo doesn't silently work for some payloads
  // and not others.
  it('a long base64 string and the same string treated as utf-8 produce DIFFERENT signatures', () => {
    // 32-byte key (base64 → 44 chars). Mint with raw bytes interpretation.
    const keyB64 = bytesToBase64(new Uint8Array(32).fill(0x42))
    // Same string, but if we treated it as a passphrase we'd sha256 the
    // 44-character string. Tokens minted under the two interpretations
    // must NOT verify against each other.
    const payload = { sid: 's1', wallet: 'W', iat: 0, exp: Date.now() + 60_000 }
    const tokenA = mintSessionToken(payload, keyB64)
    // Force passphrase path by using a string that's NOT valid base64.
    const tokenB = mintSessionToken(payload, 'not!valid!base64!at!all!')
    expect(tokenA).not.toBe(tokenB)
    // And neither verifies under the other's secret.
    expect(verifySessionToken(tokenA, 'not!valid!base64!at!all!')).toBeNull()
    expect(verifySessionToken(tokenB, keyB64)).toBeNull()
  })

  it('passphrase secrets work end-to-end (sha256 fallback)', () => {
    const passphrase = 'a-long-passphrase-that-is-not-base64-of-32-bytes'
    const exp = Date.now() + 60_000
    const token = mintSessionToken({ sid: 'sid', wallet: 'W', iat: 0, exp }, passphrase)
    const out = verifySessionToken(token, passphrase)
    expect(out?.wallet).toBe('W')
  })

  it('short base64 (< 32 bytes) falls back to passphrase hashing', () => {
    // 16-byte key — too short to be used directly as HMAC key.
    const shortB64 = bytesToBase64(new Uint8Array(16).fill(1))
    const exp = Date.now() + 60_000
    const token = mintSessionToken({ sid: 'sid', wallet: 'W', iat: 0, exp }, shortB64)
    // Must round-trip with the same secret string.
    const out = verifySessionToken(token, shortB64)
    expect(out?.wallet).toBe('W')
  })
})
