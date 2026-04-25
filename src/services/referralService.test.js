import { beforeEach, describe, it, expect } from 'vitest'
import {
  generateReferralCode,
  getReferralLink,
  registerReferralCode,
  resolveReferrerWallet,
  getActiveReferrerWallet,
  recordReferralEarning,
  getReferralStats,
  isValidReferralCode,
  captureReferralFromUrl,
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

describe('isValidReferralCode', () => {
  it('accepts 8-char base58', () => {
    expect(isValidReferralCode('AAAAAAAA')).toBe(true)
    expect(isValidReferralCode('7xKp3mNq')).toBe(true)
  })

  it('rejects too short or too long', () => {
    expect(isValidReferralCode('abc')).toBe(false)
    expect(isValidReferralCode('a'.repeat(17))).toBe(false)
  })

  it('rejects non-base58 characters', () => {
    expect(isValidReferralCode('AAAA0AAA')).toBe(false)   // 0 not in base58
    expect(isValidReferralCode('AAAAOAAA')).toBe(false)   // O not in base58
    expect(isValidReferralCode('AAAAIAAA')).toBe(false)   // I not in base58
    expect(isValidReferralCode('AAAAlAAA')).toBe(false)   // l not in base58
  })

  it('rejects script and url-y inputs', () => {
    expect(isValidReferralCode('<script>')).toBe(false)
    expect(isValidReferralCode('https://')).toBe(false)
    expect(isValidReferralCode('')).toBe(false)
    expect(isValidReferralCode(null)).toBe(false)
    expect(isValidReferralCode(undefined)).toBe(false)
    expect(isValidReferralCode(12345678)).toBe(false)
  })
})

describe('registerReferralCode collision guard', () => {
  it('first writer wins; second wallet with same prefix cannot steal mapping', () => {
    registerReferralCode('AAAAAAAA-first-wallet-tail')
    registerReferralCode('AAAAAAAA-attacker-vanity-prefix')
    expect(resolveReferrerWallet('AAAAAAAA')).toBe('AAAAAAAA-first-wallet-tail')
  })

  it('idempotent for the same wallet', () => {
    registerReferralCode('AAAAAAAA-the-rest')
    registerReferralCode('AAAAAAAA-the-rest')
    expect(resolveReferrerWallet('AAAAAAAA')).toBe('AAAAAAAA-the-rest')
  })
})

describe('resolveReferrerWallet input validation', () => {
  it('returns null for invalid codes regardless of registry contents', () => {
    // Manually plant a bogus key that would never come from a valid pubkey.
    localStorage.setItem('predictflow_referral_registry', JSON.stringify({ '<script>': 'attacker-pubkey' }))
    expect(resolveReferrerWallet('<script>')).toBeNull()
  })
})

describe('captureReferralFromUrl input validation', () => {
  it('drops invalid URL ref values silently', () => {
    const fakeWindow = { location: { search: '?ref=' + 'A'.repeat(200) } }
    const original = window.location
    Object.defineProperty(window, 'location', { value: fakeWindow.location, writable: true, configurable: true })
    expect(captureReferralFromUrl()).toBeNull()
    expect(localStorage.getItem('predictflow_referrer')).toBeNull()
    Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
  })

  it('accepts a valid base58 ref', () => {
    const original = window.location
    Object.defineProperty(window, 'location', {
      value: { search: '?ref=7xKp3mNq', origin: original.origin },
      writable: true,
      configurable: true,
    })
    expect(captureReferralFromUrl()).toBe('7xKp3mNq')
    Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
  })
})

describe('getActiveReferrerWallet', () => {
  it('returns null without a captured referrer', () => {
    expect(getActiveReferrerWallet('me-pubkey')).toBeNull()
  })

  it('skips self-referral', () => {
    // Use only base58 chars: SELFXXXX is S,E,L,F,X,X,X,X
    localStorage.setItem('predictflow_referrer', JSON.stringify('SELFXXXX'))
    registerReferralCode('SELFXXXX-pubkey-rest')
    expect(getActiveReferrerWallet('SELFXXXX-pubkey-rest')).toBeNull()
  })

  it('returns referrer wallet for foreign code', () => {
    // FRENDXXX = F,R,E,N,D,X,X,X — all base58.
    localStorage.setItem('predictflow_referrer', JSON.stringify('FRENDXXX'))
    registerReferralCode('FRENDXXX-other-pubkey')
    expect(getActiveReferrerWallet('me-pubkey')).toBe('FRENDXXX-other-pubkey')
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
