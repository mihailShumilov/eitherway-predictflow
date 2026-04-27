// AES-256-GCM envelope encryption for signed-transaction blobs.
//
// Why: a signed-but-unbroadcast Solana transaction is a replayable bearer
// credential for a specific trade. If our D1 row is leaked, the attacker
// can replay every queued limit order — but only those exact orders,
// only until the durable nonce is advanced. Encrypting at rest with a key
// held only in Worker secrets makes a stolen DB dump useless without the
// key, raising the bar from "leaked DB == replay" to "leaked DB AND
// leaked Worker secret == replay".
//
// Format on disk: separate fields for the AES-GCM nonce (`signed_tx_iv`,
// 12 bytes) and the ciphertext+tag (`signed_tx_enc`). Stored as BLOBs.

import { base64ToBytes, randomBytes } from './crypto'

// Cache imported CryptoKey by raw-key value. Worker isolates persist module
// state across requests, so re-importing the same key on every call is wasted
// work — but caching unkeyed would cause "decrypt with wrong key actually
// uses cached right key" bugs (caught by encryption.test.ts).
const keyCache = new Map<string, CryptoKey>()

async function getKey(rawKeyB64: string): Promise<CryptoKey> {
  const cached = keyCache.get(rawKeyB64)
  if (cached) return cached
  const k = base64ToBytes(rawKeyB64)
  if (k.length !== 32) throw new Error('SIGNED_TX_KEY must be 32 bytes (base64 of 32 bytes = 44 chars)')
  const imported = await crypto.subtle.importKey(
    'raw',
    k,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
  keyCache.set(rawKeyB64, imported)
  return imported
}

export type EncryptedBlob = {
  iv: Uint8Array
  ciphertext: Uint8Array
}

export async function encrypt(plaintext: Uint8Array, rawKeyB64: string): Promise<EncryptedBlob> {
  const key = await getKey(rawKeyB64)
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv, ciphertext: new Uint8Array(ct) }
}

export async function decrypt(blob: EncryptedBlob, rawKeyB64: string): Promise<Uint8Array> {
  const key = await getKey(rawKeyB64)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, blob.ciphertext)
  return new Uint8Array(pt)
}
