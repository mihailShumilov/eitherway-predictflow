import { describe, it, expect } from 'vitest'
import { parseHash, formatHash } from './route'

describe('parseHash', () => {
  it('defaults to explore for empty/root hashes', () => {
    expect(parseHash('')).toEqual({ page: 'explore' })
    expect(parseHash('#')).toEqual({ page: 'explore' })
    expect(parseHash('#/')).toEqual({ page: 'explore' })
  })

  it('parses portfolio page', () => {
    expect(parseHash('#/portfolio')).toEqual({ page: 'portfolio' })
  })

  it('parses market ticker', () => {
    expect(parseHash('#/market/KXNBA-26-PHX')).toEqual({
      page: 'explore',
      marketTicker: 'KXNBA-26-PHX',
    })
  })

  it('parses market ticker with side', () => {
    expect(parseHash('#/market/KXNBA-26-PHX?side=yes')).toEqual({
      page: 'explore',
      marketTicker: 'KXNBA-26-PHX',
      side: 'yes',
    })
  })

  it('ignores invalid side', () => {
    expect(parseHash('#/market/X?side=maybe')).toEqual({
      page: 'explore',
      marketTicker: 'X',
    })
  })

  it('decodes encoded tickers', () => {
    expect(parseHash('#/market/foo%2Fbar').marketTicker).toBe('foo/bar')
  })

  it('falls back to explore for unknown pages', () => {
    expect(parseHash('#/nope')).toEqual({ page: 'explore' })
  })
})

describe('formatHash', () => {
  it('returns root for explore', () => {
    expect(formatHash({})).toBe('#/')
    expect(formatHash({ page: 'explore' })).toBe('#/')
  })

  it('formats portfolio', () => {
    expect(formatHash({ page: 'portfolio' })).toBe('#/portfolio')
  })

  it('formats market with ticker', () => {
    expect(formatHash({ marketTicker: 'KXNBA-26-PHX' })).toBe('#/market/KXNBA-26-PHX')
  })

  it('formats market with side', () => {
    expect(formatHash({ marketTicker: 'X', side: 'no' })).toBe('#/market/X?side=no')
  })

  it('omits unknown side', () => {
    expect(formatHash({ marketTicker: 'X', side: 'maybe' })).toBe('#/market/X')
  })

  it('round-trips', () => {
    const cases = [
      { page: 'explore' },
      { page: 'portfolio' },
      { page: 'explore', marketTicker: 'A-B-C' },
      { page: 'explore', marketTicker: 'A-B-C', side: 'yes' },
    ]
    for (const c of cases) {
      expect(parseHash(formatHash(c))).toEqual(c)
    }
  })
})
