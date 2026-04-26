import { describe, it, expect } from 'vitest'
import {
  normalizeCandle,
  normalizeLevel,
  normalizeTrade,
  normalizeMarket,
  extractOutcomeMints,
  isMarketTradeable,
} from './normalize'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

describe('normalizeCandle', () => {
  it('parses seconds timestamp into ms', () => {
    const c = normalizeCandle({ t: 1_700_000_000, o: 0.5, h: 0.6, l: 0.4, c: 0.55 })
    expect(c.time).toBe(1_700_000_000_000)
    expect(c.close).toBe(0.55)
  })

  it('rejects payloads without parseable open/close', () => {
    expect(normalizeCandle({ t: 1, o: 'x', c: 'y' })).toBeNull()
    expect(normalizeCandle(null)).toBeNull()
  })
})

describe('normalizeLevel', () => {
  it('accepts object and tuple forms', () => {
    expect(normalizeLevel({ price: 0.5, size: 100 })).toEqual({ price: 0.5, size: 100 })
    expect(normalizeLevel([0.5, 100])).toEqual({ price: 0.5, size: 100 })
  })

  it('returns null for malformed', () => {
    expect(normalizeLevel(null)).toBeNull()
    expect(normalizeLevel({ price: 'x' })).toBeNull()
  })
})

describe('normalizeTrade', () => {
  it('normalizes side aliases', () => {
    expect(normalizeTrade({ price: 0.5, amount: 100, side: 'ask' }, 0).side).toBe('sell')
    expect(normalizeTrade({ price: 0.5, amount: 100, side: 'buy' }, 0).side).toBe('buy')
  })

  it('computes total', () => {
    const t = normalizeTrade({ price: 0.5, amount: 100, t: 0 }, 0)
    expect(t.total).toBe(50)
  })

  it('parses DFlow live trade shape', () => {
    const t = normalizeTrade({
      tradeId: 'abc',
      ticker: 'KXNBA-26-LAL',
      yesPriceDollars: '0.0600',
      countFp: '17.20',
      takerSide: 'yes',
      createdTime: 1777150514,
    }, 0)
    expect(t.id).toBe('abc')
    expect(t.price).toBe(0.06)
    expect(t.amount).toBe(17)
    expect(t.side).toBe('buy')
    expect(t.time).toBe(new Date(1777150514_000).toISOString())
  })

  it('rescales integer-cents price', () => {
    const t = normalizeTrade({ price: 60, count: 5 }, 0)
    expect(t.price).toBe(0.6)
  })

  it('maps takerSide=no to sell', () => {
    expect(normalizeTrade({ yesPriceDollars: '0.5', countFp: '1', takerSide: 'no' }, 0).side).toBe('sell')
  })
})

describe('normalizeMarket', () => {
  it('infers side from matching mint', () => {
    const m = normalizeMarket(
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.7, noAsk: 0.3 } },
      'N'
    )
    expect(m.side).toBe('no')
    expect(m.currentPrice).toBe(0.3)
  })

  it('returns null for non-object payloads', () => {
    expect(normalizeMarket(null)).toBeNull()
    expect(normalizeMarket('string')).toBeNull()
  })

  it('reads mints from nested DFlow accounts shape', () => {
    const m = normalizeMarket(
      {
        market: {
          accounts: {
            [USDC]: { yesMint: 'Y', noMint: 'N', isInitialized: true },
          },
          yesAsk: 0.7,
          noAsk: 0.3,
        },
      },
      'N'
    )
    expect(m.yesMint).toBe('Y')
    expect(m.noMint).toBe('N')
    expect(m.side).toBe('no')
  })
})

describe('extractOutcomeMints', () => {
  it('prefers top-level fields when present', () => {
    expect(extractOutcomeMints({ yesMint: 'Y', noMint: 'N' })).toEqual({ yesMint: 'Y', noMint: 'N' })
  })

  it('reads from accounts[USDC] when initialized', () => {
    expect(extractOutcomeMints({
      accounts: { [USDC]: { yesMint: 'Y', noMint: 'N', isInitialized: true } },
    })).toEqual({ yesMint: 'Y', noMint: 'N' })
  })

  it('skips uninitialized accounts', () => {
    expect(extractOutcomeMints({
      accounts: { [USDC]: { yesMint: 'Y', noMint: 'N', isInitialized: false } },
    })).toEqual({ yesMint: null, noMint: null })
  })

  it('falls back to any initialized account when USDC entry is missing', () => {
    expect(extractOutcomeMints({
      accounts: { OTHER: { yesMint: 'Y', noMint: 'N', isInitialized: true } },
    })).toEqual({ yesMint: 'Y', noMint: 'N' })
  })

  it('returns nulls for empty/missing data', () => {
    expect(extractOutcomeMints({})).toEqual({ yesMint: null, noMint: null })
    expect(extractOutcomeMints(null)).toEqual({ yesMint: null, noMint: null })
  })
})

describe('isMarketTradeable', () => {
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  const past = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const mints = { yesMint: 'YYY', noMint: 'NNN' }

  it('returns true for active markets with future close time and mints', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: future, ...mints })).toBe(true)
  })

  it('returns false when status is finalized', () => {
    expect(isMarketTradeable({ status: 'finalized', closeTime: future, ...mints })).toBe(false)
  })

  it('returns false when close time has passed', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: past, ...mints })).toBe(false)
  })

  it('treats missing close time as tradeable when status and mints are set', () => {
    expect(isMarketTradeable({ status: 'active', ...mints })).toBe(true)
  })

  it('returns false when outcome mints are missing', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: future })).toBe(false)
    expect(isMarketTradeable({ status: 'active', closeTime: future, yesMint: 'YYY' })).toBe(false)
    expect(isMarketTradeable({ status: 'active', closeTime: future, noMint: 'NNN' })).toBe(false)
  })

  it('returns false for nullish input', () => {
    expect(isMarketTradeable(null)).toBe(false)
    expect(isMarketTradeable(undefined)).toBe(false)
  })
})
