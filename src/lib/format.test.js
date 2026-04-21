import { describe, it, expect } from 'vitest'
import { formatUsd, formatCompactNumber, priceToPercent, priceToPercentFine, shortAddress } from './format'

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
})
