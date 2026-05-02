// Executor keypair — the keeper-controlled key that signs approval-flow
// swap transactions on-chain.
//
// Trust model:
//   - The executor is a hot key held server-side as a Worker secret
//     (EXECUTOR_SECRET_KEY). On-chain authority is bounded per user by
//     spl-token `approve` allowances — the keeper can spend up to the
//     delegated amount on each user's ATA, no more, and the user can
//     `revoke` at any time to wipe the delegation.
//   - Compromise lets an attacker spend up to the sum of active per-user
//     delegations across all approved mints, plus DoS pending orders by
//     burning durable nonces (the executor is the nonce authority). It
//     does NOT grant access to user funds beyond the per-user delegation.
//
// Recovery: rotate via clean cutover — cancel in-flight orders, ask users
// to revoke, deploy new key, users approve to the new pubkey on next
// placement.

import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import type { Env } from '../env'

// Cache keyed by the secret string itself so a runtime rotation in the
// same isolate (e.g. preview env update) doesn't return the stale Keypair.
let cachedSecret: string | null = null
let cachedKeypair: Keypair | null = null

export function loadExecutorKeypair(env: Env): Keypair {
  const secret = env.EXECUTOR_SECRET_KEY
  if (!secret) {
    throw new Error('EXECUTOR_SECRET_KEY not configured — set via `wrangler secret put EXECUTOR_SECRET_KEY`')
  }
  if (cachedKeypair && cachedSecret === secret) return cachedKeypair
  const bytes = bs58.decode(secret.trim())
  if (bytes.length !== 64) {
    throw new Error(`EXECUTOR_SECRET_KEY must decode to 64 bytes (got ${bytes.length})`)
  }
  cachedKeypair = Keypair.fromSecretKey(bytes)
  cachedSecret = secret
  return cachedKeypair
}

export function getExecutorPubkey(env: Env): string {
  return loadExecutorKeypair(env).publicKey.toBase58()
}
