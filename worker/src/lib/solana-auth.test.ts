import { describe, it, expect } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { verifyChallenge } from './solana-auth'
import { base58 } from './crypto'

// Deterministic keypair for signing test challenges.
const priv = new Uint8Array(32).fill(7)
const pub = ed25519.getPublicKey(priv)
const wallet = base58.encode(pub)

function sign(message: string): string {
  return base58.encode(ed25519.sign(new TextEncoder().encode(message), priv))
}

// Mock D1: the prepared statement's first() returns `returnRow`, and we record
// every SQL string so the test can assert how the challenge is consumed.
function mockDb(returnRow: unknown, sqlSink: string[]) {
  return {
    prepare(sql: string) {
      sqlSink.push(sql)
      return {
        bind: () => ({
          async first() { return returnRow },
          async run() { return { meta: { changes: returnRow ? 1 : 0 } } },
        }),
      }
    },
  } as unknown as D1Database
}

describe('verifyChallenge atomic claim', () => {
  const now = Date.now()
  const message = 'predictflow wants you to sign in...'
  const goodRow = { nonce: 'n1', wallet, message, issued_at: now, expires_at: now + 100_000 }

  it('claims the challenge with DELETE ... RETURNING (not SELECT)', async () => {
    const sql: string[] = []
    await verifyChallenge({ db: mockDb(goodRow, sql), wallet, nonce: 'n1', signatureBase58: sign(message) })
    expect(sql[0]).toMatch(/DELETE FROM auth_challenges/)
    expect(sql[0]).toMatch(/RETURNING/)
    // No separate SELECT/DELETE round-trip — the claim is a single statement.
    expect(sql).toHaveLength(1)
  })

  it('accepts a valid signature for the claimed challenge', async () => {
    const sql: string[] = []
    const res = await verifyChallenge({ db: mockDb(goodRow, sql), wallet, nonce: 'n1', signatureBase58: sign(message) })
    expect(res.ok).toBe(true)
  })

  it('rejects when the row was already claimed (RETURNING gives nothing)', async () => {
    const sql: string[] = []
    const res = await verifyChallenge({ db: mockDb(null, sql), wallet, nonce: 'n1', signatureBase58: sign(message) })
    expect(res).toEqual({ ok: false, reason: 'Challenge not found or already used' })
  })

  it('rejects an expired challenge', async () => {
    const sql: string[] = []
    const expiredRow = { ...goodRow, expires_at: now - 1 }
    const res = await verifyChallenge({ db: mockDb(expiredRow, sql), wallet, nonce: 'n1', signatureBase58: sign(message) })
    expect(res).toEqual({ ok: false, reason: 'Challenge expired' })
  })

  it('rejects an invalid signature (challenge still consumed by the claim)', async () => {
    const sql: string[] = []
    const res = await verifyChallenge({ db: mockDb(goodRow, sql), wallet, nonce: 'n1', signatureBase58: sign('different message') })
    expect(res).toEqual({ ok: false, reason: 'Invalid signature' })
  })
})
