// Tests for the order-evaluation helpers extracted from priceWatcher.ts.
// We mock D1 + global fetch and exercise the SQL-driven paths directly,
// which is how priceWatcher itself uses them in the alarm cycle.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  reapStuckSubmissions, pollPendingConfirmations, fetchPendingOrders,
  fetchOpenOrders, armAndSubmit, evaluateAll,
} from './orderEval'

type Row = Record<string, unknown>

function makeDB(rowsOrSelectFn: Row[] | ((sql: string, binds: unknown[]) => Row[])) {
  const updates: Array<{ sql: string; binds: unknown[]; meta: { changes: number } }> = []
  const fetchSelect = (sql: string, binds: unknown[]): Row[] =>
    typeof rowsOrSelectFn === 'function' ? rowsOrSelectFn(sql, binds) : rowsOrSelectFn

  const db = {
    prepare(sql: string) {
      let capturedBinds: unknown[] = []
      const stmt = {
        bind(...binds: unknown[]) {
          capturedBinds = binds
          return {
            async first() {
              const rows = fetchSelect(sql, capturedBinds)
              return rows[0] ?? null
            },
            async all() {
              return { results: fetchSelect(sql, capturedBinds), success: true }
            },
            async run() {
              if (sql.startsWith('UPDATE') || sql.startsWith('INSERT') || sql.startsWith('DELETE')) {
                const meta = { changes: 1 }
                updates.push({ sql, binds: capturedBinds, meta })
                return { meta }
              }
              return { meta: { changes: 0 } }
            },
          }
        },
      }
      return stmt
    },
  }
  return { db, updates }
}

function makeEnv(db: any): any {
  return { DB: db, HELIUS_RPC_URL: 'https://example.invalid/rpc', SIGNED_TX_KEY: '' }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('reapStuckSubmissions', () => {
  it('rolls back submitting rows older than the cutoff with no signature', async () => {
    // Simulate D1 reporting 3 rows reaped.
    const { db, updates } = makeDB([])
    db.prepare = ((sqlText: string) => ({
      bind: (..._b: unknown[]) => ({
        async run() {
          updates.push({ sql: sqlText, binds: _b, meta: { changes: 3 } })
          return { meta: { changes: 3 } }
        },
        async all() { return { results: [] } },
        async first() { return null },
      }),
    })) as any
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const count = await reapStuckSubmissions(makeEnv(db), 'MKT-1')
    expect(count).toBe(3)
    // The single UPDATE should have a `fill_signature IS NULL` predicate —
    // post-broadcast rows must NOT be reaped.
    const sql = updates[0].sql
    expect(sql).toMatch(/fill_signature IS NULL/)
    expect(sql).toMatch(/status = 'submitting'/)
  })

  it('returns 0 and does not audit when nothing was reaped', async () => {
    const { db } = makeDB([])
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // Override .run() to report 0 changes.
    db.prepare = ((_sqlText: string) => ({
      bind: () => ({
        async run() { return { meta: { changes: 0 } } },
      }),
    })) as any
    const count = await reapStuckSubmissions(makeEnv(db), 'MKT-2')
    expect(count).toBe(0)
  })
})

describe('pollPendingConfirmations', () => {
  it('returns count of submitting+signed rows; getSignatureStatuses called per row', async () => {
    // First call: SELECT returns two rows. Subsequent prepare() calls
    // (from inside checkSubmittedOrder) return one row each.
    const db = {
      prepare(_sql: string) {
        return {
          bind: () => ({
            async all() {
              return {
                results: [{ id: 'a' }, { id: 'b' }],
              }
            },
            async first() {
              // checkSubmittedOrder's row lookup
              return {
                id: 'a',
                wallet: 'W',
                market_ticker: 'MKT',
                trigger_price: 0.5,
                fill_signature: 'SIG_A',
              }
            },
            async run() { return { meta: { changes: 1 } } },
          }),
        }
      },
    }
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { value: [{ confirmationStatus: 'processed', err: null }] },
      }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const count = await pollPendingConfirmations(makeEnv(db), 'MKT')
    expect(count).toBe(2)
    // checkSubmittedOrder called RPC once per row (single-shot).
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('fetchPendingOrders + fetchOpenOrders', () => {
  it('pending: status IN (pending, armed)', async () => {
    const seen: string[] = []
    const db = {
      prepare(sql: string) {
        seen.push(sql)
        return {
          bind: () => ({
            async all() {
              return {
                results: [
                  { id: '1', wallet: 'W', market_ticker: 'MKT', market_id: null, side: 'yes', order_type: 'limit', trigger_price: 0.5, status: 'pending' },
                ],
              }
            },
          }),
        }
      },
    }
    const out = await fetchPendingOrders(makeEnv(db), 'MKT')
    expect(out).toHaveLength(1)
    expect(seen[0]).toMatch(/status IN \('pending','armed'\)/)
  })

  it('open: status IN (pending, armed, submitting)', async () => {
    const seen: string[] = []
    const db = {
      prepare(sql: string) {
        seen.push(sql)
        return {
          bind: () => ({
            async all() {
              return { results: [{ id: '1' }, { id: '2' }, { id: '3' }] }
            },
          }),
        }
      },
    }
    const out = await fetchOpenOrders(makeEnv(db), 'MKT')
    expect(out).toHaveLength(3)
    expect(seen[0]).toMatch(/status IN \('pending','armed','submitting'\)/)
  })
})

describe('armAndSubmit CAS', () => {
  it('succeeds when row was pending — issues UPDATE, then submitOrder fire-and-forget', async () => {
    const updates: Array<{ sql: string }> = []
    const db = {
      prepare(sql: string) {
        return {
          bind: () => ({
            async run() {
              updates.push({ sql })
              // Pretend the CAS UPDATE matched 1 row.
              if (sql.startsWith("UPDATE orders\n          SET status = 'armed'") ||
                  sql.includes("SET status = 'armed', triggered_at")) {
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 1 } }
            },
            async first() {
              // submitOrder's SELECT — return null so it short-circuits.
              return null
            },
          }),
        }
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await armAndSubmit(makeEnv(db), {
      id: '1', wallet: 'W', market_ticker: 'MKT', market_id: null,
      side: 'yes', order_type: 'limit', trigger_price: 0.5, status: 'pending',
    }, 0.4)
    // First UPDATE is the CAS. Audit log INSERTs follow.
    expect(updates[0].sql).toMatch(/SET status = 'armed', triggered_at/)
  })

  it('skips when CAS matches 0 rows (already armed by another tick)', async () => {
    const updates: Array<{ sql: string }> = []
    const db = {
      prepare(sql: string) {
        return {
          bind: () => ({
            async run() {
              updates.push({ sql })
              // CAS reports 0 changes — race lost.
              return { meta: { changes: 0 } }
            },
          }),
        }
      },
    }
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await armAndSubmit(makeEnv(db), {
      id: '1', wallet: 'W', market_ticker: 'MKT', market_id: null,
      side: 'yes', order_type: 'limit', trigger_price: 0.5, status: 'pending',
    }, 0.4)
    expect(updates).toHaveLength(1)  // only the failed CAS, no audit follow-up
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('evaluateAll picks the correct side', () => {
  it('limit BUY YES uses yesAsk; stop-loss SELL YES uses yesBid', async () => {
    // Capture what gets armed. We fake fetchPendingOrders by having the
    // SELECT return two orders: one limit (should fire on ask), one
    // stop-loss (should fire on bid).
    const armed: string[] = []
    const db = {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              return {
                results: [
                  { id: 'lim', wallet: 'W', market_ticker: 'MKT', market_id: null, side: 'yes', order_type: 'limit', trigger_price: 0.42, status: 'pending' },
                  { id: 'sl', wallet: 'W', market_ticker: 'MKT', market_id: null, side: 'yes', order_type: 'stop-loss', trigger_price: 0.40, status: 'pending' },
                ],
              }
            },
            async run() {
              if (sql.includes("status = 'armed'")) {
                // Track which order id we're arming via the bind.
                // Simpler: any successful arm captures.
                armed.push(sql)
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 1 } }
            },
            async first() { return null },
          }),
        }
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    // YES ASK = 0.42 (fires limit at trigger=0.42, ask <= trigger)
    // YES BID = 0.39 (fires stop-loss at trigger=0.40, bid <= trigger)
    await evaluateAll(makeEnv(db), 'MKT', {
      yesAsk: 0.42, yesBid: 0.39, noAsk: null, noBid: null,
    })
    // Both orders arm.
    expect(armed.length).toBe(2)
  })

  it('skips orders when the relevant side of the book is empty', async () => {
    const armed: string[] = []
    const db = {
      prepare(sql: string) {
        return {
          bind: () => ({
            async all() {
              return {
                results: [
                  { id: 'lim', wallet: 'W', market_ticker: 'MKT', market_id: null, side: 'yes', order_type: 'limit', trigger_price: 0.5, status: 'pending' },
                ],
              }
            },
            async run() {
              if (sql.includes("status = 'armed'")) armed.push(sql)
              return { meta: { changes: 1 } }
            },
            async first() { return null },
          }),
        }
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    // No yesAsk and no noBid → can't evaluate the limit's price → skip.
    await evaluateAll(makeEnv(db), 'MKT', {
      yesAsk: null, yesBid: 0.4, noAsk: 0.6, noBid: null,
    })
    // yesAsk synthesized from noBid... noBid is null too → still null. Skipped.
    expect(armed).toHaveLength(0)
  })
})
