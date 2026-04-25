// Fee calculation + tier persistence + tier gating.
//
// Tier state lives in localStorage keyed by wallet pubkey for the MVP. Real
// production would resolve tier on-chain (subscription program) or server-side
// (signed JWT). The 30-day expiry is a soft check enforced here on read.

import { FEE_CONFIG } from '../config/fees'
import { safeGet, safeSet, safeRemove } from '../lib/storage'

const TIER_KEY_PREFIX = 'predictflow_tier_'
const TIER_EXPIRES_PREFIX = 'predictflow_tier_expires_'

export const TIER_KEYS = ['FREE', 'PRO', 'WHALE']

function tierKey(walletPubkey) {
  return `${TIER_KEY_PREFIX}${walletPubkey || 'anonymous'}`
}

function expiresKey(walletPubkey) {
  return `${TIER_EXPIRES_PREFIX}${walletPubkey || 'anonymous'}`
}

export function getUserTier(walletPubkey) {
  if (!walletPubkey) return 'FREE'
  const stored = safeGet(tierKey(walletPubkey), null)
  if (!stored || !TIER_KEYS.includes(stored)) return 'FREE'
  if (stored === 'FREE') return 'FREE'
  const expires = Number(safeGet(expiresKey(walletPubkey), 0)) || 0
  if (expires && expires < Date.now()) {
    safeRemove(tierKey(walletPubkey))
    safeRemove(expiresKey(walletPubkey))
    return 'FREE'
  }
  return stored
}

export function setUserTier(walletPubkey, tier, { months = 1 } = {}) {
  if (!walletPubkey) return
  if (!TIER_KEYS.includes(tier)) return
  if (tier === 'FREE') {
    safeRemove(tierKey(walletPubkey))
    safeRemove(expiresKey(walletPubkey))
    return
  }
  const expiresAt = Date.now() + months * FEE_CONFIG.SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000
  safeSet(tierKey(walletPubkey), tier)
  safeSet(expiresKey(walletPubkey), expiresAt)
}

export function getTierExpiry(walletPubkey) {
  if (!walletPubkey) return null
  const expires = Number(safeGet(expiresKey(walletPubkey), 0)) || 0
  return expires || null
}

export function getTierConfig(tier) {
  return FEE_CONFIG.TIERS[tier] || FEE_CONFIG.TIERS.FREE
}

// Pure: rounding to 6 decimal places matches USDC precision so the
// computed feeAmount * 1e6 cleanly converts to lamports.
function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

export function calculateFee(inputAmountUSDC, userTier, hasReferrer = false) {
  const tierConfig = getTierConfig(userTier)
  const feeBps = tierConfig.swapFeeBps

  if (!(inputAmountUSDC > 0) || inputAmountUSDC < FEE_CONFIG.MIN_TRADE_FOR_FEE) {
    return {
      inputAmount: inputAmountUSDC || 0,
      feeAmount: 0,
      netAmount: inputAmountUSDC || 0,
      feeBps: 0,
      referralAmount: 0,
      platformAmount: 0,
      tier: userTier,
    }
  }

  const feeAmount = round6((inputAmountUSDC * feeBps) / 10_000)
  const netAmount = round6(inputAmountUSDC - feeAmount)

  let referralAmount = 0
  let platformAmount = feeAmount

  if (hasReferrer) {
    referralAmount = round6((feeAmount * FEE_CONFIG.REFERRAL_SHARE_PERCENT) / 100)
    platformAmount = round6(feeAmount - referralAmount)
  }

  return {
    inputAmount: inputAmountUSDC,
    feeAmount,
    netAmount,
    feeBps,
    referralAmount,
    platformAmount,
    tier: userTier,
  }
}

export function canCreateConditionalOrder(userTier, currentActiveOrders) {
  const maxOrders = getTierConfig(userTier).conditionalOrders
  if (currentActiveOrders >= maxOrders) {
    return {
      allowed: false,
      reason: userTier === 'FREE'
        ? 'Free tier allows 1 active conditional order. Upgrade to Pro for up to 10.'
        : userTier === 'PRO'
          ? 'You have reached your Pro tier order limit (10). Upgrade to Whale for unlimited orders.'
          : 'Order limit reached.',
    }
  }
  return { allowed: true }
}

export function canUseDCA(userTier) {
  return getTierConfig(userTier).dcaEnabled
}

export function tierComparator(tier) {
  return TIER_KEYS.indexOf(tier)
}
