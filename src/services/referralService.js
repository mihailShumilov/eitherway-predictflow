// Referral tracking. Codes are derived from wallet pubkey (first 8 chars) so
// every connected wallet has a stable shareable code with no extra signup.
//
// MVP storage:
//   predictflow_referrer            — code captured from this device's first ?ref= visit
//   predictflow_referral_registry   — { [code]: pubkey } map populated when wallets connect
//   predictflow_referral_earnings   — { [pubkey]: { earned: number, count: number } }
//
// Production would replace the registry+earnings with an on-chain or backend store.

import { safeGet, safeSet } from '../lib/storage'

const REFERRER_KEY = 'predictflow_referrer'
const REGISTRY_KEY = 'predictflow_referral_registry'
const EARNINGS_KEY = 'predictflow_referral_earnings'

// Codes are pubkey prefixes, so they must look like base58 (Solana's
// alphabet — no 0, O, I, l). Length 4–16 spans short demo codes through
// the full 8-char default with a generous upper bound.
const REFERRAL_CODE_RE = /^[1-9A-HJ-NP-Za-km-z]{4,16}$/

export function isValidReferralCode(code) {
  return typeof code === 'string' && REFERRAL_CODE_RE.test(code)
}

export function generateReferralCode(walletPubkey) {
  if (!walletPubkey) return ''
  return walletPubkey.slice(0, 8)
}

export function getReferralLink(code) {
  if (typeof window === 'undefined') return ''
  if (!code) return ''
  const origin = window.location.origin
  return `${origin}/?ref=${code}`
}

// Run once on app boot — captures ?ref= the first time a visitor lands.
// Subsequent visits don't overwrite so a referrer is "sticky" for that browser.
// Invalid shapes are dropped silently — an attacker can't plant arbitrary
// strings (including very long ones) in localStorage via the URL.
export function captureReferralFromUrl() {
  if (typeof window === 'undefined') return null
  try {
    const urlParams = new URLSearchParams(window.location.search)
    const ref = urlParams.get('ref')
    if (!ref) return safeGet(REFERRER_KEY, null)
    if (!isValidReferralCode(ref)) return safeGet(REFERRER_KEY, null)
    const existing = safeGet(REFERRER_KEY, null)
    if (existing) return existing
    safeSet(REFERRER_KEY, ref)
    return ref
  } catch {
    return null
  }
}

export function getReferrerCode() {
  return safeGet(REFERRER_KEY, null)
}

export function clearReferrer() {
  try { localStorage.removeItem(REFERRER_KEY) } catch { /* ignore */ }
}

// Registers the connecting wallet's code → pubkey mapping. If the slot is
// already claimed by a different pubkey we leave it alone — first-write wins.
// Otherwise a vanity prefix collision would let the second wallet steal all
// future referral payouts addressed to the first wallet's code.
export function registerReferralCode(walletPubkey) {
  if (!walletPubkey) return
  const code = generateReferralCode(walletPubkey)
  if (!isValidReferralCode(code)) return
  const registry = safeGet(REGISTRY_KEY, {}) || {}
  const existing = registry[code]
  if (existing === walletPubkey) return
  if (existing && existing !== walletPubkey) return
  registry[code] = walletPubkey
  safeSet(REGISTRY_KEY, registry)
}

export function resolveReferrerWallet(code) {
  if (!isValidReferralCode(code)) return null
  const registry = safeGet(REGISTRY_KEY, {}) || {}
  return registry[code] || null
}

// Don't credit self-referrals — a user clicking their own link shouldn't
// earn 20% on their own trades.
export function getActiveReferrerWallet(currentWallet) {
  const code = getReferrerCode()
  if (!code) return null
  const referrerWallet = resolveReferrerWallet(code)
  if (!referrerWallet) return null
  if (referrerWallet === currentWallet) return null
  return referrerWallet
}

export function recordReferralEarning(referrerPubkey, amountUSDC) {
  if (!referrerPubkey || !(amountUSDC > 0)) return
  const earnings = safeGet(EARNINGS_KEY, {}) || {}
  const prev = earnings[referrerPubkey] || { earned: 0, count: 0 }
  earnings[referrerPubkey] = {
    earned: prev.earned + amountUSDC,
    count: prev.count + 1,
  }
  safeSet(EARNINGS_KEY, earnings)
}

export function getReferralStats(walletPubkey) {
  if (!walletPubkey) return { earned: 0, count: 0 }
  const earnings = safeGet(EARNINGS_KEY, {}) || {}
  return earnings[walletPubkey] || { earned: 0, count: 0 }
}
