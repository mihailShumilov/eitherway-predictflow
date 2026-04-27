// /orders POST validation matrix.
//
// We instantiate the Hono app with mocked D1 + DO bindings and exercise
// the rejection paths the auditor flagged as untested. Each test verifies
// the response code and the error code in the standard envelope.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import app from '../index'
import { decrypt } from '../lib/encryption'
import { mintSessionToken } from '../lib/session'
import { bytesToBase64 } from '../lib/crypto'

const SESSION_SIGNING_KEY = bytesToBase64(new Uint8Array(32).fill(0x55))
const SIGNED_TX_KEY = bytesToBase64(new Uint8Array(32).fill(0x77))
const WALLET = 'AbC1' + '1'.repeat(40)  // 44 base58 chars

function mintToken(wallet = WALLET, sid = 'sid-1', ttlMs = 60_000) {
  return mintSessionToken({
    sid, wallet, iat: Date.now(), exp: Date.now() + ttlMs,
  }, SESSION_SIGNING_KEY)
}

// Minimal D1 mock — supports the queries this test surface invokes.
function makeDB(opts: {
  sessionRow?: { revoked_at: number | null } | null  // explicit null = "session row not found"
  nonceRow?: { pubkey: string } | null
  insertedOrders?: any[]
} = {}) {
  const insertedOrders: any[] = opts.insertedOrders ?? []
  // Treat `undefined` (option not passed) as "default healthy session row".
  // Treat `null` (explicitly passed) as "session not found".
  const sessionRow = 'sessionRow' in opts ? opts.sessionRow : { revoked_at: null }
  return {
    prepare(sql: string) {
      return {
        bind(..._binds: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM sessions')) return sessionRow
              if (sql.includes('FROM durable_nonces')) return opts.nonceRow ?? null
              return null
            },
            async run() {
              if (sql.startsWith('INSERT INTO orders')) {
                insertedOrders.push(_binds)
                return { meta: { changes: 1 } }
              }
              return { meta: { changes: 1 } }
            },
            async all() {
              return { results: [] }
            },
          }
        },
      }
    },
    insertedOrders,
  }
}

function makeEnv(overrides: Partial<any> = {}): any {
  return {
    DB: makeDB(),
    PRICE_WATCHER: {
      idFromName: (_name: string) => ({ toString: () => '_' }),
      get: (_id: any) => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    },
    ENVIRONMENT: 'preview',
    DFLOW_REST_BASE: '',
    DFLOW_TRADE_BASE: '',
    DFLOW_WS_URL: '',
    SOLANA_NETWORK: 'mainnet',
    USDC_MINT: 'USDC',
    ALLOWED_ORIGIN: 'http://localhost:5173',
    SESSION_TTL_SECONDS: '600',
    SIGNED_TX_KEY,
    SESSION_SIGNING_KEY,
    DFLOW_API_KEY: '',
    HELIUS_RPC_URL: '',
    ...overrides,
  }
}

function ctx(env: any): any {
  return {
    env,
    // Cast to any — Workers' real ExecutionContext has more fields, but
    // the only one our routes use is waitUntil; tests don't assert on the rest.
    executionCtx: {
      waitUntil: (_p: Promise<any>) => {},
      passThroughOnException: () => {},
    } as any,
  }
}

async function postOrder(env: any, body: any, opts: { token?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? mintToken()}`
  const req = new Request('http://test/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return await app.fetch(req, env, ctx(env).executionCtx)
}

const minimalValidBody = () => ({
  marketTicker: 'BTCD-25DEC0313-T92749.99',
  side: 'yes',
  orderType: 'limit',
  triggerPrice: 0.5,
  amountUsdc: 1,
  yesMint: WALLET,  // any base58 32-byte string passes isValidPubkey
  noMint: WALLET,
  signedTxBase64: bytesToBase64(new Uint8Array(200).fill(1)),
  durableNoncePubkey: WALLET,
  durableNonceValue: 'NONCE-VAL',
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('POST /orders — validation matrix', () => {
  it('401 when no Authorization header', async () => {
    const env = makeEnv()
    const res = await postOrder(env, minimalValidBody(), { token: null })
    expect(res.status).toBe(401)
    const body: any = await res.json()
    expect(body.error).toBe('missing_authorization')
    expect(body.requestId).toBeTruthy()
  })

  it('401 with code session_revoked when session is revoked', async () => {
    const env = makeEnv()
    env.DB = makeDB({ sessionRow: { revoked_at: Date.now() - 1000 } })
    const res = await postOrder(env, minimalValidBody())
    expect(res.status).toBe(401)
    const body: any = await res.json()
    expect(body.error).toBe('session_revoked')
  })

  it('401 with code session_not_found when session row missing', async () => {
    const env = makeEnv()
    env.DB = makeDB({ sessionRow: null })
    const res = await postOrder(env, minimalValidBody())
    expect(res.status).toBe(401)
    const body: any = await res.json()
    expect(body.error).toBe('session_not_found')
  })

  it('400 validation_failed when marketTicker missing', async () => {
    const env = makeEnv()
    env.DB = makeDB({ nonceRow: { pubkey: WALLET } })
    const body = { ...minimalValidBody(), marketTicker: '' }
    const res = await postOrder(env, body)
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
    expect(j.detail).toContain('marketTicker required')
  })

  it('400 validation_failed when side is invalid', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalValidBody(), side: 'maybe' })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when orderType is invalid', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalValidBody(), orderType: 'twap' })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when triggerPrice out of (0, 1)', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalValidBody(), triggerPrice: 1.5 })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when amountUsdc <= 0', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalValidBody(), amountUsdc: 0 })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 signed_tx_required when signedTxBase64 missing', async () => {
    const env = makeEnv()
    const body = { ...minimalValidBody() } as any
    delete body.signedTxBase64
    const res = await postOrder(env, body)
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('signed_tx_required')
  })

  it('400 durable_nonce_required when nonce pubkey missing', async () => {
    const env = makeEnv()
    const body = { ...minimalValidBody() } as any
    delete body.durableNoncePubkey
    const res = await postOrder(env, body)
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('durable_nonce_required')
  })

  it('400 durable_nonce_value_required when nonce value missing', async () => {
    const env = makeEnv()
    const body = { ...minimalValidBody() } as any
    delete body.durableNonceValue
    const res = await postOrder(env, body)
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('durable_nonce_value_required')
  })

  it('400 nonce_not_registered when nonce row missing for wallet', async () => {
    const env = makeEnv()
    env.DB = makeDB({ nonceRow: null })
    const res = await postOrder(env, minimalValidBody())
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('nonce_not_registered')
  })

  it('400 invalid_signed_tx_base64 when signedTxBase64 isn\'t valid base64', async () => {
    const env = makeEnv()
    env.DB = makeDB({ nonceRow: { pubkey: WALLET } })
    const res = await postOrder(env, {
      ...minimalValidBody(),
      signedTxBase64: '!!!not-base64!!!',
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('invalid_signed_tx_base64')
  })

  it('400 signed_tx_size_out_of_range for too-small payload', async () => {
    const env = makeEnv()
    env.DB = makeDB({ nonceRow: { pubkey: WALLET } })
    const res = await postOrder(env, {
      ...minimalValidBody(),
      signedTxBase64: bytesToBase64(new Uint8Array(10)),  // < SIGNED_TX_MIN_BYTES (64)
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('signed_tx_size_out_of_range')
  })

  it('201 on a fully valid request — encrypts the blob, persists the row', async () => {
    const insertedOrders: any[] = []
    const env = makeEnv()
    env.DB = makeDB({ nonceRow: { pubkey: WALLET }, insertedOrders })
    const res = await postOrder(env, minimalValidBody())
    expect(res.status).toBe(201)
    const j: any = await res.json()
    expect(j.id).toBeTruthy()
    expect(j.status).toBe('pending')
    // The INSERT should have stored encrypted bytes — verify by decrypting
    // back. The bind args order matches the INSERT statement: id, wallet,
    // marketTicker, marketId, eventTicker, side, orderType, triggerPrice,
    // amountUsdc, yesMint, noMint, encCiphertext, encIV, ...
    expect(insertedOrders).toHaveLength(1)
    const binds = insertedOrders[0]
    const cipher = binds[11]
    const iv = binds[12]
    const decrypted = await decrypt({ ciphertext: new Uint8Array(cipher), iv: new Uint8Array(iv) }, SIGNED_TX_KEY)
    expect(decrypted.length).toBe(200)  // matches minimalValidBody payload
  })
})
