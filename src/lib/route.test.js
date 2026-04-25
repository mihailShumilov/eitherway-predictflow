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

  it('parses category', () => {
    expect(parseHash('#/category/Sports')).toEqual({
      page: 'explore',
      category: 'Sports',
    })
  })

  it('parses category with subcategory', () => {
    expect(parseHash('#/category/Sports/Soccer')).toEqual({
      page: 'explore',
      category: 'Sports',
      subcategory: 'Soccer',
    })
  })

  it('decodes encoded category names with spaces', () => {
    expect(parseHash('#/category/Climate%20and%20Weather')).toEqual({
      page: 'explore',
      category: 'Climate and Weather',
    })
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

  it('formats category', () => {
    expect(formatHash({ category: 'Sports' })).toBe('#/category/Sports')
  })

  it('formats category + subcategory', () => {
    expect(formatHash({ category: 'Sports', subcategory: 'Soccer' })).toBe(
      '#/category/Sports/Soccer',
    )
  })

  it('treats All category as root', () => {
    expect(formatHash({ category: 'All' })).toBe('#/')
  })

  it('round-trips', () => {
    const cases = [
      { page: 'explore' },
      { page: 'portfolio' },
      { page: 'explore', marketTicker: 'A-B-C' },
      { page: 'explore', marketTicker: 'A-B-C', side: 'yes' },
      { page: 'explore', category: 'Sports' },
      { page: 'explore', category: 'Sports', subcategory: 'Soccer' },
      { page: 'explore', category: 'Climate and Weather' },
    ]
    for (const c of cases) {
      expect(parseHash(formatHash(c))).toEqual(c)
    }
  })
})
