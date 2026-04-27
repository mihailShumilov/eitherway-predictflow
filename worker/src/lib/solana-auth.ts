// Sign-in with Solana — minimal implementation.
//
// Flow:
//   1. Client calls POST /auth/challenge with { wallet }. Server returns a
//      human-readable message containing a domain, a single-use nonce, and
//      issued/expires timestamps. Server stores (nonce, wallet, message).
//   2. User's wallet signs the message bytes (utf-8). Client POSTs
//      { wallet, signature, nonce } to /auth/verify.
//   3. Server looks up the challenge, verifies the ed25519 signature
//      against the wallet pubkey, mints a session token, and deletes the
//      challenge so it cannot be reused.
//
// We follow the SIWS spec text format closely enough that a wallet's
// "Sign In with Solana" UI displays it sensibly, while keeping the
// implementation small (no external SIWS lib dependency).

import { ed25519 } from '@noble/curves/ed25519'
import { base58, randomBytes, bytesToHex } from './crypto'

const CHALLENGE_TTL_SECONDS = 300        // 5 min
const CHALLENGE_DELETE_AFTER_USE = true  // single-use nonce

export type ChallengeRecord = {
  nonce: string
  wallet: string
  message: string
  issued_at: number
  expires_at: number
}

export function buildSiwsMessage(opts: {
  domain: string
  wallet: string
  nonce: string
  issuedAt: Date
  expiresAt: Date
  uri: string
  chainId: 'mainnet' | 'devnet'
}): string {
  // The SIWS standard message format. Keep field order — wallets parse it.
  const lines = [
    `${opts.domain} wants you to sign in with your Solana account:`,
    opts.wallet,
    '',
    'Sign in to PredictFlow to manage your limit orders.',
    '',
    `URI: ${opts.uri}`,
    'Version: 1',
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt.toISOString()}`,
    `Expiration Time: ${opts.expiresAt.toISOString()}`,
  ]
  return lines.join('\n')
}

export async function createChallenge(opts: {
  db: D1Database
  domain: string
  uri: string
  chainId: 'mainnet' | 'devnet'
  wallet: string
}): Promise<ChallengeRecord> {
  // Validate the pubkey before we issue anything — no point storing
  // garbage that can never verify.
  if (!isValidPubkey(opts.wallet)) {
    throw new ChallengeError(400, 'Invalid wallet pubkey')
  }
  const nonceBytes = randomBytes(16)
  const nonce = bytesToHex(nonceBytes)
  const now = Date.now()
  const issuedAt = new Date(now)
  const expiresAt = new Date(now + CHALLENGE_TTL_SECONDS * 1000)
  const message = buildSiwsMessage({
    domain: opts.domain,
    wallet: opts.wallet,
    nonce,
    issuedAt,
    expiresAt,
    uri: opts.uri,
    chainId: opts.chainId,
  })

  await opts.db
    .prepare(
      `INSERT INTO auth_challenges (nonce, wallet, message, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(nonce, opts.wallet, message, now, now + CHALLENGE_TTL_SECONDS * 1000)
    .run()

  return {
    nonce,
    wallet: opts.wallet,
    message,
    issued_at: now,
    expires_at: now + CHALLENGE_TTL_SECONDS * 1000,
  }
}

export async function verifyChallenge(opts: {
  db: D1Database
  wallet: string
  nonce: string
  signatureBase58: string
}): Promise<{ ok: true; message: string } | { ok: false; reason: string }> {
  const row = await opts.db
    .prepare(
      `SELECT nonce, wallet, message, issued_at, expires_at
         FROM auth_challenges
        WHERE nonce = ? AND wallet = ?`,
    )
    .bind(opts.nonce, opts.wallet)
    .first<ChallengeRecord>()

  if (!row) return { ok: false, reason: 'Challenge not found or already used' }
  if (row.expires_at < Date.now()) {
    await opts.db.prepare('DELETE FROM auth_challenges WHERE nonce = ?').bind(row.nonce).run()
    return { ok: false, reason: 'Challenge expired' }
  }

  // Verify signature: ed25519 over the UTF-8 bytes of the message.
  let pubkeyBytes: Uint8Array
  let signatureBytes: Uint8Array
  try {
    pubkeyBytes = base58.decode(opts.wallet)
    signatureBytes = base58.decode(opts.signatureBase58)
  } catch {
    return { ok: false, reason: 'Invalid base58 in wallet or signature' }
  }
  if (pubkeyBytes.length !== 32) return { ok: false, reason: 'Wallet must be 32 bytes' }
  if (signatureBytes.length !== 64) return { ok: false, reason: 'Signature must be 64 bytes' }

  const messageBytes = new TextEncoder().encode(row.message)
  const valid = ed25519.verify(signatureBytes, messageBytes, pubkeyBytes)
  if (!valid) return { ok: false, reason: 'Invalid signature' }

  if (CHALLENGE_DELETE_AFTER_USE) {
    await opts.db.prepare('DELETE FROM auth_challenges WHERE nonce = ?').bind(row.nonce).run()
  }
  return { ok: true, message: row.message }
}

export function isValidPubkey(s: string): boolean {
  try {
    const decoded = base58.decode(s)
    return decoded.length === 32
  } catch {
    return false
  }
}

export class ChallengeError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
