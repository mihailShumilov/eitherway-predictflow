import { describe, it, expect } from 'vitest'
import {
  normalizeCandle,
  normalizeLevel,
  normalizeTrade,
  normalizeMarket,
  extractOutcomeMints,
  isMarketTradeable,
  canBuySide,
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

  it('marks active markets as not settled', () => {
    const m = normalizeMarket(
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.4, noAsk: 0.6, status: 'active' } },
      'Y'
    )
    expect(m.settled).toBe(false)
    expect(m.wonSide).toBeNull()
  })

  it('marks finalized markets as settled and infers winner from prices', () => {
    // YES collapsed to ~$0.99, NO collapsed to ~$0.01 → YES won.
    const m = normalizeMarket(
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.99, noAsk: 0.01, status: 'finalized' } },
      'Y'
    )
    expect(m.settled).toBe(true)
    expect(m.wonSide).toBe('yes')
  })

  it('infers NO winner from collapsed prices on a determined market', () => {
    const m = normalizeMarket(
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.01, noAsk: 0.99, status: 'determined' } },
      'N'
    )
    expect(m.settled).toBe(true)
    expect(m.wonSide).toBe('no')
  })

  it('prefers explicit result field over price inference', () => {
    const m = normalizeMarket(
      // Prices haven't snapped yet, but the market explicitly resolved YES.
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.5, noAsk: 0.5, status: 'finalized', result: 'yes' } },
      'Y'
    )
    expect(m.wonSide).toBe('yes')
  })

  it('returns null wonSide for voided markets', () => {
    const m = normalizeMarket(
      { market: { yesMint: 'Y', noMint: 'N', yesAsk: 0.5, noAsk: 0.5, status: 'finalized', result: 'void' } },
      'Y'
    )
    expect(m.settled).toBe(true)
    expect(m.wonSide).toBeNull()
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
  const liquidity = { yesBid: '0.40', yesAsk: '0.42', noBid: '0.58', noAsk: '0.60' }

  it('returns true for active markets with future close time, mints, and a live book', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: future, ...mints, ...liquidity })).toBe(true)
  })

  it('returns false when status is finalized', () => {
    expect(isMarketTradeable({ status: 'finalized', closeTime: future, ...mints, ...liquidity })).toBe(false)
  })

  it('returns false when close time has passed', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: past, ...mints, ...liquidity })).toBe(false)
  })

  it('treats missing close time as tradeable when status, mints, and a level are set', () => {
    expect(isMarketTradeable({ status: 'active', ...mints, ...liquidity })).toBe(true)
  })

  it('returns false when outcome mints are missing', () => {
    expect(isMarketTradeable({ status: 'active', closeTime: future, ...liquidity })).toBe(false)
    expect(isMarketTradeable({ status: 'active', closeTime: future, yesMint: 'YYY', ...liquidity })).toBe(false)
    expect(isMarketTradeable({ status: 'active', closeTime: future, noMint: 'NNN', ...liquidity })).toBe(false)
  })

  it('returns false when the book is fully empty (all four levels null)', () => {
    expect(isMarketTradeable({
      status: 'active', closeTime: future, ...mints,
      yesBid: null, yesAsk: null, noBid: null, noAsk: null,
    })).toBe(false)
  })

  it('returns true with partial liquidity (only one side resting)', () => {
    // Mirrors a near-resolved market where only the YES bid + NO ask remain.
    // NO is still buyable (and YES still sellable) so the market stays tradeable.
    expect(isMarketTradeable({
      status: 'active', closeTime: future, ...mints,
      yesBid: '0.99', yesAsk: null, noBid: null, noAsk: '0.01',
    })).toBe(true)
  })

  it('returns false for nullish input', () => {
    expect(isMarketTradeable(null)).toBe(false)
    expect(isMarketTradeable(undefined)).toBe(false)
  })
})

describe('canBuySide', () => {
  it('YES is buyable when yesAsk is present', () => {
    expect(canBuySide({ yesAsk: '0.42', noBid: null }, 'yes')).toBe(true)
  })

  it('YES is buyable when noBid is present (derives yesAsk = 1 − noBid)', () => {
    expect(canBuySide({ yesAsk: null, noBid: '0.58' }, 'yes')).toBe(true)
  })

  it('YES is NOT buyable when both yesAsk and noBid are null', () => {
    expect(canBuySide({ yesAsk: null, noBid: null }, 'yes')).toBe(false)
  })

  it('NO is buyable when noAsk OR yesBid is present', () => {
    expect(canBuySide({ noAsk: '0.60', yesBid: null }, 'no')).toBe(true)
    expect(canBuySide({ noAsk: null, yesBid: '0.40' }, 'no')).toBe(true)
  })

  it('NO is NOT buyable when both noAsk and yesBid are null', () => {
    expect(canBuySide({ noAsk: null, yesBid: null }, 'no')).toBe(false)
  })

  it('rejects garbage side or null market', () => {
    expect(canBuySide(null, 'yes')).toBe(false)
    expect(canBuySide({ yesAsk: '0.5' }, 'maybe')).toBe(false)
  })
})
