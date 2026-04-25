import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { calculateFee, getUserTier, setUserTier, canCreateConditionalOrder, canUseDCA } from './feeService'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('calculateFee', () => {
  it('charges 0.30% for FREE tier', () => {
    const r = calculateFee(100, 'FREE')
    expect(r.feeBps).toBe(30)
    expect(r.feeAmount).toBeCloseTo(0.3, 6)
    expect(r.netAmount).toBeCloseTo(99.7, 6)
    expect(r.platformAmount).toBeCloseTo(0.3, 6)
    expect(r.referralAmount).toBe(0)
  })

  it('charges 0.15% for PRO tier', () => {
    const r = calculateFee(100, 'PRO')
    expect(r.feeBps).toBe(15)
    expect(r.feeAmount).toBeCloseTo(0.15, 6)
    expect(r.netAmount).toBeCloseTo(99.85, 6)
  })

  it('charges 0.05% for WHALE tier', () => {
    const r = calculateFee(1000, 'WHALE')
    expect(r.feeBps).toBe(5)
    expect(r.feeAmount).toBeCloseTo(0.5, 6)
  })

  it('waives fee below MIN_TRADE_FOR_FEE', () => {
    const r = calculateFee(0.5, 'FREE')
    expect(r.feeAmount).toBe(0)
    expect(r.netAmount).toBe(0.5)
    expect(r.feeBps).toBe(0)
  })

  it('splits 20% to referrer when present', () => {
    const r = calculateFee(100, 'FREE', true)
    expect(r.feeAmount).toBeCloseTo(0.3, 6)
    expect(r.referralAmount).toBeCloseTo(0.06, 6)
    expect(r.platformAmount).toBeCloseTo(0.24, 6)
  })

  it('returns zero fee on invalid input', () => {
    const r = calculateFee(0, 'FREE')
    expect(r.feeAmount).toBe(0)
    expect(r.netAmount).toBe(0)
  })
})

describe('getUserTier / setUserTier', () => {
  it('defaults to FREE', () => {
    expect(getUserTier('any-pubkey')).toBe('FREE')
  })

  it('persists Pro upgrade and reads back', () => {
    setUserTier('pubkey-1', 'PRO')
    expect(getUserTier('pubkey-1')).toBe('PRO')
  })

  it('expires lapsed subscription back to FREE', () => {
    setUserTier('pubkey-1', 'PRO')
    // Force expiry into the past.
    const expiredAt = Date.now() - 1000
    localStorage.setItem('predictflow_tier_expires_pubkey-1', JSON.stringify(expiredAt))
    expect(getUserTier('pubkey-1')).toBe('FREE')
  })

  it('downgrade clears tier', () => {
    setUserTier('pubkey-1', 'WHALE')
    setUserTier('pubkey-1', 'FREE')
    expect(getUserTier('pubkey-1')).toBe('FREE')
  })
})

describe('tier gates', () => {
  it('FREE tier allows 1 conditional order', () => {
    expect(canCreateConditionalOrder('FREE', 0).allowed).toBe(true)
    expect(canCreateConditionalOrder('FREE', 1).allowed).toBe(false)
  })

  it('PRO tier allows 10', () => {
    expect(canCreateConditionalOrder('PRO', 9).allowed).toBe(true)
    expect(canCreateConditionalOrder('PRO', 10).allowed).toBe(false)
  })

  it('WHALE tier allows unlimited', () => {
    expect(canCreateConditionalOrder('WHALE', 9999).allowed).toBe(true)
  })

  it('DCA gated to PRO+', () => {
    expect(canUseDCA('FREE')).toBe(false)
    expect(canUseDCA('PRO')).toBe(true)
    expect(canUseDCA('WHALE')).toBe(true)
  })
})
