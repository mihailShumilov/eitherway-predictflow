// /orders POST validation matrix.
//
// We instantiate the Hono app with mocked D1 + DO bindings and exercise
// the rejection paths the auditor flagged as untested. Each test verifies
// the response code and the error code in the standard envelope.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// vitest's source-loader for @solana/spl-token sometimes makes
// findProgramAddressSync's curve check misbehave. Production runs the
// real function correctly — we keep the route's contract intact and just
// mock the ATA helper to a deterministic per-mint value here. Tests
// pass the same string the route's call site receives.
const fixtures = vi.hoisted(() => ({
  // Deterministic seed-derived pubkeys (kept in sync with WALLET_KP).
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDC_ATA:  '2ne1mMzY9mQUhaGXu2DAZALo5QfWNKBSYmcm1QReM61w',
  YES_MINT:  '6JhaGdekBjU2RfiYWSjYdQAibx4LfSfTNFEeMUHnUVz7',
  YES_ATA:   '4VZjdPrxhskbtynPYa5GFPvRGQRsXcCXymsbU5HzD8nu',
  NO_MINT:   '2ru5PcgeQzxF7QZYwQgDkG2K13PRqyigVw99zMYg8eML',
  NO_ATA:    '8xLcDDoAcgWB59tH4LEjP7sfYCgWvWWadrW5wwBe6kDC',
}))

vi.mock('@solana/spl-token', async (orig) => {
  const actual: any = await orig()
  // Build a fake PublicKey-shaped return by reusing the real PublicKey class
  // — but route through a string so we don't trigger the curve math that
  // breaks in this environment. We provide just the toBase58() method that
  // the route consumes.
  const fake = (s: string) => ({ toBase58: () => s })
  return {
    ...actual,
    getAssociatedTokenAddressSync: vi.fn((mint: any) => {
      const m = String(mint?.toBase58?.() ?? mint)
      if (m === fixtures.USDC_MINT) return fake(fixtures.USDC_ATA)
      if (m === fixtures.YES_MINT) return fake(fixtures.YES_ATA)
      if (m === fixtures.NO_MINT) return fake(fixtures.NO_ATA)
      throw new Error(`unmocked ATA mint: ${m}`)
    }),
  }
})

import app from '../index'
import { decrypt } from '../lib/encryption'
import { mintSessionToken } from '../lib/session'
import { bytesToBase64 } from '../lib/crypto'
import { Keypair } from '@solana/web3.js'

const SESSION_SIGNING_KEY = bytesToBase64(new Uint8Array(32).fill(0x55))
const SIGNED_TX_KEY = bytesToBase64(new Uint8Array(32).fill(0x77))
function kpFromSeed(byte: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(byte))
}
const WALLET_KP = kpFromSeed(0x10)
const WALLET = WALLET_KP.publicKey.toBase58()
const USDC_MINT_TEST = fixtures.USDC_MINT
const YES_MINT = fixtures.YES_MINT
const NO_MINT = fixtures.NO_MINT
const FAKE_SIG = '1'.repeat(88)
const USDC_ATA = fixtures.USDC_ATA
const YES_ATA = fixtures.YES_ATA

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
    USDC_MINT: USDC_MINT_TEST,
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
  yesMint: YES_MINT,
  noMint: NO_MINT,
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

// ---- Approval-flow validation ----------------------------------------

const minimalApprovalBody = () => ({
  flow: 'approval',
  marketTicker: 'BTCD-25DEC0313-T92749.99',
  side: 'yes',
  orderType: 'limit',
  triggerPrice: 0.5,
  amountUsdc: 1,
  yesMint: YES_MINT,
  noMint: NO_MINT,
  approvalSignature: FAKE_SIG,
  delegatedAmountAtPlacement: 1_000_000,
  userInputAta: USDC_ATA,
  inputMint: USDC_MINT_TEST,
  outputMint: YES_MINT,
})

describe('POST /orders flow=approval validation', () => {
  it('201 on a valid approval body — persists row with flow=approval and no signed_tx', async () => {
    const insertedOrders: any[] = []
    const env = makeEnv()
    env.DB = makeDB({ insertedOrders })
    const res = await postOrder(env, minimalApprovalBody())
    expect(res.status).toBe(201)
    const j: any = await res.json()
    expect(j.id).toBeTruthy()
    expect(j.status).toBe('pending')
    // Two INSERTs: orders + token_approvals (best-effort ledger). The
    // first is the orders row.
    expect(insertedOrders.length).toBeGreaterThanOrEqual(1)
    const orderBinds = insertedOrders[0]
    // Approval-flow INSERT order:
    //   id, wallet, market_ticker, market_id, event_ticker,
    //   side, order_type, trigger_price, amount_usdc, yes_mint, no_mint,
    //   flow, approval_signature, delegated_amount_at_placement,
    //   user_input_ata, input_mint, output_mint, created_at, updated_at
    expect(orderBinds[11]).toBe('approval')
    expect(orderBinds[12]).toBe(FAKE_SIG)
    expect(orderBinds[13]).toBe(1_000_000)
  })

  it('400 validation_failed when approvalSignature missing', async () => {
    const env = makeEnv()
    const body = { ...minimalApprovalBody() } as any
    delete body.approvalSignature
    const res = await postOrder(env, body)
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
    expect((j.detail as string[]).some((d) => d.includes('approvalSignature'))).toBe(true)
  })

  it('400 validation_failed when approvalSignature is not base58 88-char', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalApprovalBody(), approvalSignature: 'too-short' })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when userInputAta is not the wallet+inputMint ATA', async () => {
    const env = makeEnv()
    const wrongAta = Keypair.generate().publicKey.toBase58()
    const res = await postOrder(env, { ...minimalApprovalBody(), userInputAta: wrongAta })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when inputMint mismatches direction matrix (limit BUY must be USDC in)', async () => {
    const env = makeEnv()
    // Limit BUY: input must be USDC. Swap input/output to violate.
    const res = await postOrder(env, {
      ...minimalApprovalBody(),
      inputMint: YES_MINT,
      outputMint: USDC_MINT_TEST,
      userInputAta: YES_ATA,
    })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when delegatedAmountAtPlacement is zero', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalApprovalBody(), delegatedAmountAtPlacement: 0 })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('400 validation_failed when userInputAta is not a valid pubkey', async () => {
    const env = makeEnv()
    const res = await postOrder(env, { ...minimalApprovalBody(), userInputAta: 'NOT-A-PUBKEY' })
    expect(res.status).toBe(400)
    const j: any = await res.json()
    expect(j.error).toBe('validation_failed')
  })

  it('does NOT require signedTxBase64 / durableNonce on approval flow', async () => {
    // Confirm approval flow doesn't fall through to legacy required-fields.
    const env = makeEnv()
    env.DB = makeDB({})  // no nonceRow; legacy path would 400 nonce_not_registered
    const res = await postOrder(env, minimalApprovalBody())
    expect(res.status).toBe(201)
  })
})
