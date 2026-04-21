import { describe, it, expect } from 'vitest'
import { normalizeCandle, normalizeLevel, normalizeTrade, normalizeMarket } from './normalize'

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
})
