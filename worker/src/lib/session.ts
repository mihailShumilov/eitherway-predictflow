// Session token issuance + verification.
//
// Tokens are HMAC-signed JSON ("compact JWT-ish" — but not actually JWT, no
// header negotiation, no alg confusion footgun). Format on the wire:
//
//   <base64url(json)>.<base64url(hmac-sha256)>
//
// Where json = { sid, wallet, iat, exp }.
// HMAC is computed over the json portion using SESSION_SIGNING_KEY.
//
// Why not JWT? JWT's "alg" header is a famous footgun (alg=none, alg
// confusion) and we don't need its flexibility. Only one issuer (this
// Worker), only one algorithm (HMAC-SHA256), only one consumer (this
// Worker). Static format eliminates a class of bugs.

import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToBase64, base64ToBytes, randomBytes, bytesToHex, timingSafeEqual } from './crypto'

export type SessionPayload = {
  sid: string       // session id (matches sessions.id row)
  wallet: string    // verified pubkey
  iat: number       // issued-at, ms epoch
  exp: number       // expires-at, ms epoch
}

function b64urlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  return base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

function hmacKey(secretB64: string): Uint8Array {
  // The secret can be either base64-encoded or a long passphrase. Accept
  // either: if it parses as base64 of length 32 we use it directly; otherwise
  // we hash it to derive a fixed-size key. Keeps `wrangler secret put`
  // ergonomic without forcing the operator to base64-encode.
  try {
    const bytes = base64ToBytes(secretB64)
    if (bytes.length >= 32) return bytes
  } catch { /* fall through */ }
  return sha256(new TextEncoder().encode(secretB64))
}

export function mintSessionToken(payload: SessionPayload, secret: string): string {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const sig = hmac(sha256, hmacKey(secret), body)
  return `${b64urlEncode(body)}.${b64urlEncode(sig)}`
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  let bodyBytes: Uint8Array, sigBytes: Uint8Array
  try {
    bodyBytes = b64urlDecode(parts[0])
    sigBytes = b64urlDecode(parts[1])
  } catch {
    return null
  }
  const expected = hmac(sha256, hmacKey(secret), bodyBytes)
  if (!timingSafeEqual(sigBytes, expected)) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch {
    return null
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  if (typeof payload.wallet !== 'string') return null
  if (typeof payload.sid !== 'string') return null
  return payload
}

export function newSessionId(): string {
  return bytesToHex(randomBytes(16))
}
