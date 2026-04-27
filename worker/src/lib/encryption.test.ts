// Smoke test the AES-GCM round-trip + session HMAC. These are pure-crypto
// helpers — running them under vitest catches "wrong web-crypto API" bugs
// before they hit the deployed Worker.

import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from './encryption'
import { mintSessionToken, verifySessionToken } from './session'
import { bytesToBase64, randomBytes } from './crypto'

const KEY = bytesToBase64(randomBytes(32))

describe('encryption (AES-256-GCM)', () => {
  it('round-trips arbitrary payloads', async () => {
    const plaintext = new TextEncoder().encode('a signed solana tx blob')
    const enc = await encrypt(plaintext, KEY)
    expect(enc.iv.length).toBe(12)
    expect(enc.ciphertext.length).toBeGreaterThan(plaintext.length) // includes 16-byte GCM tag
    const dec = await decrypt(enc, KEY)
    expect(new TextDecoder().decode(dec)).toBe('a signed solana tx blob')
  })

  it('rejects ciphertext encrypted under a different key', async () => {
    const enc = await encrypt(new TextEncoder().encode('secret'), KEY)
    const otherKey = bytesToBase64(randomBytes(32))
    await expect(decrypt(enc, otherKey)).rejects.toBeTruthy()
  })

  it('rejects an undersized key (must be 32 bytes)', async () => {
    const tooShort = bytesToBase64(randomBytes(16))
    await expect(encrypt(new Uint8Array([1]), tooShort)).rejects.toThrow(/32 bytes/)
  })
})

describe('session tokens', () => {
  const SECRET = bytesToBase64(randomBytes(32))

  it('verifies a freshly-minted token', () => {
    const exp = Date.now() + 60_000
    const token = mintSessionToken({ sid: 's1', wallet: 'PUBKEY', iat: Date.now(), exp }, SECRET)
    const out = verifySessionToken(token, SECRET)
    expect(out?.wallet).toBe('PUBKEY')
    expect(out?.sid).toBe('s1')
  })

  it('rejects a token whose body was swapped while keeping the original signature', () => {
    const exp = Date.now() + 60_000
    const token = mintSessionToken({ sid: 's1', wallet: 'GOOD', iat: 0, exp }, SECRET)
    const sig = token.split('.')[1]
    // Encode a fresh body claiming a different wallet, paste the original sig.
    // A correct verifier MUST recompute HMAC and reject.
    const evilBody = btoa(JSON.stringify({ sid: 's1', wallet: 'EVIL', iat: 0, exp }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(verifySessionToken(`${evilBody}.${sig}`, SECRET)).toBeNull()
  })

  it('rejects a token signed with a different key', () => {
    const exp = Date.now() + 60_000
    const token = mintSessionToken({ sid: 's1', wallet: 'PUBKEY', iat: Date.now(), exp }, SECRET)
    const otherSecret = bytesToBase64(randomBytes(32))
    expect(verifySessionToken(token, otherSecret)).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = mintSessionToken({ sid: 's1', wallet: 'PUBKEY', iat: 0, exp: 1 }, SECRET)
    expect(verifySessionToken(token, SECRET)).toBeNull()
  })
})
