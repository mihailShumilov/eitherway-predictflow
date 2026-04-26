import { describe, it, expect } from 'vitest'
import { formatUsd, formatCompactNumber, priceToPercent, priceToPercentFine, shortAddress, humanizeOutcomeLabel } from './format'

describe('format', () => {
  it('formatUsd handles dollars, K, M, B', () => {
    expect(formatUsd(42)).toBe('$42')
    expect(formatUsd(1500)).toBe('$2K')
    expect(formatUsd(1_200_000)).toBe('$1.2M')
    expect(formatUsd(3_400_000_000)).toBe('$3.4B')
  })

  it('formatUsd handles nullish + NaN', () => {
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(NaN)).toBe('—')
  })

  it('formatCompactNumber strips the $ sign', () => {
    expect(formatCompactNumber(1500)).toBe('2K')
  })

  it('priceToPercent rounds 0.50 → 50¢', () => {
    expect(priceToPercent(0.5)).toBe('50¢')
    expect(priceToPercentFine(0.537)).toBe('53.7¢')
  })

  it('shortAddress preserves short strings', () => {
    expect(shortAddress('abc')).toBe('abc')
    expect(shortAddress('abcdef1234567890')).toBe('abcd…7890')
  })

  it('humanizeOutcomeLabel appends % for score/rating contexts', () => {
    expect(humanizeOutcomeLabel('Above 85', 'Michael Rotten Tomatoes score?')).toBe('Above 85%')
    expect(humanizeOutcomeLabel('Below 60', 'Movie rating')).toBe('Below 60%')
    expect(humanizeOutcomeLabel('Above 85', 'Pro Basketball Champion')).toBe('Above 85')
  })

  it('humanizeOutcomeLabel prepends $ for price contexts', () => {
    expect(humanizeOutcomeLabel('70,000 to 74,999.99', 'Bitcoin price at the end of 2026')).toBe('$70,000 to $74,999.99')
    expect(humanizeOutcomeLabel('999.99 or below', 'Ethereum price at the end of 2026')).toBe('$999.99 or below')
  })

  it('humanizeOutcomeLabel leaves non-numeric labels alone', () => {
    expect(humanizeOutcomeLabel('Liverpool', 'English Premier League Winner?')).toBe('Liverpool')
    expect(humanizeOutcomeLabel('', 'whatever')).toBe('')
    expect(humanizeOutcomeLabel(null, 'whatever')).toBe('')
  })
})
