import { beforeEach, describe, it, expect } from 'vitest'
import {
  generateReferralCode,
  getReferralLink,
  registerReferralCode,
  resolveReferrerWallet,
  getActiveReferrerWallet,
  recordReferralEarning,
  getReferralStats,
} from './referralService'

beforeEach(() => {
  localStorage.clear()
})

describe('referral codes', () => {
  it('uses first 8 chars of pubkey as code', () => {
    expect(generateReferralCode('7xKp3mNqAbCdEfGh')).toBe('7xKp3mNq')
  })

  it('builds a /?ref= link from origin', () => {
    const link = getReferralLink('7xKp3mNq')
    expect(link).toContain('?ref=7xKp3mNq')
  })

  it('registry maps code → pubkey', () => {
    registerReferralCode('AAAAAAAA-the-rest')
    expect(resolveReferrerWallet('AAAAAAAA')).toBe('AAAAAAAA-the-rest')
  })
})

describe('getActiveReferrerWallet', () => {
  it('returns null without a captured referrer', () => {
    expect(getActiveReferrerWallet('me-pubkey')).toBeNull()
  })

  it('skips self-referral', () => {
    localStorage.setItem('predictflow_referrer', JSON.stringify('SELFCODE'))
    registerReferralCode('SELFCODE-pubkey-rest')
    // current wallet matches the resolved one — should be null
    expect(getActiveReferrerWallet('SELFCODE-pubkey-rest')).toBeNull()
  })

  it('returns referrer wallet for foreign code', () => {
    localStorage.setItem('predictflow_referrer', JSON.stringify('FRIENDFR'))
    registerReferralCode('FRIENDFR-other-pubkey')
    expect(getActiveReferrerWallet('me-pubkey')).toBe('FRIENDFR-other-pubkey')
  })
})

describe('referral earnings', () => {
  it('accumulates earned amount and count', () => {
    recordReferralEarning('alice', 0.5)
    recordReferralEarning('alice', 0.25)
    const stats = getReferralStats('alice')
    expect(stats.earned).toBeCloseTo(0.75, 6)
    expect(stats.count).toBe(2)
  })

  it('ignores non-positive amounts', () => {
    recordReferralEarning('alice', 0)
    recordReferralEarning('alice', -1)
    const stats = getReferralStats('alice')
    expect(stats.count).toBe(0)
  })
})
