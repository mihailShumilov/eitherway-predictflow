// Submitter unit tests — focuses on RPC-error classification and the
// state-machine paths that decide retryable vs permanent.
//
// We don't spin up a real Worker runtime; instead we mock D1 + global
// fetch and call the exported submitOrder/checkSubmittedOrder functions
// directly. The point is to lock in the classification matrix.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { submitOrder, checkSubmittedOrder } from './submitter'
import { encrypt } from './encryption'
import { bytesToBase64 } from './crypto'

const KEY = bytesToBase64(new Uint8Array(32).fill(7))

// ---- Test doubles ----

type Stmt = { sql: string; binds: unknown[] }

function makeDB(seedRow: any | null = null) {
  const stmts: Stmt[] = []
  let row = seedRow
  const updates: Array<{ status?: string; failure_reason?: string; fill_signature?: string }> = []
  const db = {
    prepare(sql: string) {
      const captured: Stmt = { sql, binds: [] }
      const stmt = {
        bind(...binds: unknown[]) {
          captured.binds = binds
          stmts.push(captured)
          return {
            async first() { return row },
            async run() {
              if (!row) return { meta: { changes: 0 } }
              // Match the SET clause prefix specifically — `sql.includes(...)`
              // would also match the WHERE predicate (e.g.
              // `UPDATE … SET status='armed' WHERE … status='submitting'`).
              if (sql.startsWith("UPDATE orders SET status = 'submitting'")) {
                if (row.status === 'armed') {
                  row.status = 'submitting'
                  updates.push({ status: 'submitting' })
                  return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
              }
              if (sql.startsWith("UPDATE orders SET status = 'armed'")) {
                row.status = 'armed'
                updates.push({ status: 'armed' })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith("UPDATE orders SET status = 'failed'")) {
                row.status = 'failed'
                row.failure_reason = String(binds[0])
                updates.push({ status: 'failed', failure_reason: row.failure_reason })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith("UPDATE orders SET status = 'filled'")) {
                row.status = 'filled'
                updates.push({ status: 'filled' })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('UPDATE orders SET fill_signature')) {
                row.fill_signature = String(binds[0])
                updates.push({ fill_signature: row.fill_signature })
                return { meta: { changes: 1 } }
              }
              if (sql.startsWith('INSERT INTO audit_log')) {
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 0 } }
            },
          }
        },
      }
      return stmt
    },
  }
  return { db, stmts, updates, getRow: () => row }
}

function makeEnv(db: any): any {
  return {
    DB: db,
    SIGNED_TX_KEY: KEY,
    HELIUS_RPC_URL: 'https://example.invalid/rpc',
  }
}

type TestRow = {
  id: string
  wallet: string
  market_ticker: string
  side: string
  order_type: string
  amount_usdc: number
  trigger_price: number
  signed_tx_enc: ArrayBufferLike
  signed_tx_iv: ArrayBufferLike
  durable_nonce: string | null
  status: string
  fill_signature: string | null
  failure_reason?: string | null
}

// Construct a minimal serialized v0 transaction whose first instruction is
// the System program's advanceNonceAccount (discriminator 0x04 0x00 0x00 0x00).
// The submitter's pre-flight nonce-position check requires this — synthetic
// random bytes would be rejected before the broadcast path under test runs.
//
// Wire format laid out: 1 byte sigCount | 64-byte sig | 0x80 v0 marker |
// 3-byte header | 1-byte numStatic | static keys (System program key first) |
// 32-byte blockhash | 1-byte numIxs | 1-byte programIdIdx (0=System) |
// 1-byte numAccounts | 1-byte dataLen | 4-byte advanceNonce data |
// 1-byte numAddressTableLookups (0).
function makeNonceFirstTxBytes(): Uint8Array {
  const out: number[] = []
  out.push(1)                        // sigCount = 1
  for (let i = 0; i < 64; i++) out.push(0)  // signature placeholder
  out.push(0x80)                     // v0 marker
  out.push(1, 0, 1)                  // header: 1 required sig, 0 readonly signed, 1 readonly unsigned
  out.push(2)                        // numStaticAccountKeys = 2
  for (let i = 0; i < 32; i++) out.push(0)  // [0] = System program (all zero)
  for (let i = 0; i < 32; i++) out.push(1)  // [1] = some other account
  for (let i = 0; i < 32; i++) out.push(2)  // recentBlockhash
  out.push(1)                        // numInstructions = 1
  out.push(0)                        // programIdIdx = 0 (System)
  out.push(0)                        // numAccounts = 0
  out.push(4)                        // dataLen = 4
  out.push(0x04, 0x00, 0x00, 0x00)   // advanceNonceAccount discriminator
  out.push(0)                        // numAddressTableLookups = 0
  return new Uint8Array(out)
}

async function makeArmedRow(): Promise<TestRow> {
  // Real-shaped serialized v0 tx so the submitter's nonce-position pre-flight
  // check accepts it. The encryption helper doesn't care about contents
  // beyond round-tripping; the byte layout matters only to the inspector.
  const fakeBytes = makeNonceFirstTxBytes()
  const enc = await encrypt(fakeBytes, KEY)
  return {
    id: 'order-1',
    wallet: 'WALLET',
    market_ticker: 'MKT',
    side: 'yes',
    order_type: 'limit',
    amount_usdc: 1,
    trigger_price: 0.5,
    signed_tx_enc: enc.ciphertext.buffer,
    signed_tx_iv: enc.iv.buffer,
    durable_nonce: null,
    status: 'armed',
    fill_signature: null,
  }
}

function rpcResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('submitOrder — RPC outcome classification', () => {
  it('happy path: broadcasts, persists fill_signature, leaves status submitting', async () => {
    const row = await makeArmedRow()
    const { db, updates } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () => rpcResponse({ jsonrpc: '2.0', id: 1, result: 'SIGNATURE_HEX' })))
    await submitOrder(makeEnv(db), 'order-1')
    // claim → broadcast → persist fill_signature
    expect(updates.find(u => u.status === 'submitting')).toBeTruthy()
    expect(updates.find(u => u.fill_signature === 'SIGNATURE_HEX')).toBeTruthy()
    expect(row.status).toBe('submitting')
    expect(row.fill_signature).toBe('SIGNATURE_HEX')
  })

  it('permanent RPC error (BlockhashNotFound) → status: failed', async () => {
    const row = await makeArmedRow()
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () =>
      rpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'Blockhash not found' } }),
    ))
    await submitOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('rpc_error')
  })

  it('transient HTTP 5xx → status: armed (retried by next eval)', async () => {
    const row = await makeArmedRow()
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream gone', { status: 503 })))
    await submitOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('armed')
  })

  it('NodeUnhealthy (-32005) is treated as transient, not permanent', async () => {
    const row = await makeArmedRow()
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () =>
      rpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Node unhealthy' } }),
    ))
    await submitOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('armed')
  })

  it('decrypt failure → status: failed', async () => {
    const row = await makeArmedRow()
    // Corrupt the ciphertext
    row.signed_tx_enc = new Uint8Array(64).buffer
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not be called') }))
    await submitOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toMatch(/decrypt_failed/)
  })

  it('non-armed status: no-op (does not double-broadcast)', async () => {
    const row = await makeArmedRow()
    row.status = 'filled'
    const { db } = makeDB(row)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await submitOrder(makeEnv(db), 'order-1')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(row.status).toBe('filled')
  })
})

describe('checkSubmittedOrder — confirmation polling', () => {
  it('confirmed → status: filled', async () => {
    const row = await makeArmedRow()
    row.status = 'submitting'
    row.fill_signature = 'SIGNATURE_HEX'
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () =>
      rpcResponse({
        jsonrpc: '2.0', id: 1,
        result: { value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: 'confirmed' }] },
      }),
    ))
    await checkSubmittedOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('filled')
  })

  it('on-chain error → status: failed', async () => {
    const row = await makeArmedRow()
    row.status = 'submitting'
    row.fill_signature = 'SIGNATURE_HEX'
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () =>
      rpcResponse({
        jsonrpc: '2.0', id: 1,
        result: { value: [{ slot: 1, confirmations: 5, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' }] },
      }),
    ))
    await checkSubmittedOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toMatch(/tx_error/)
  })

  it('still processing → no status change, alarm tries again', async () => {
    const row = await makeArmedRow()
    row.status = 'submitting'
    row.fill_signature = 'SIGNATURE_HEX'
    const { db } = makeDB(row)
    vi.stubGlobal('fetch', vi.fn(async () =>
      rpcResponse({
        jsonrpc: '2.0', id: 1,
        result: { value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: 'processed' }] },
      }),
    ))
    await checkSubmittedOrder(makeEnv(db), 'order-1')
    expect(row.status).toBe('submitting')
  })
})
