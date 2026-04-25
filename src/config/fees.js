// PredictFlow monetization config: fee tiers, referral share, fee wallet.
//
// FEE_WALLET is the Solana pubkey that receives platform fees and tier
// subscription payments. Override with VITE_FEE_WALLET. The placeholder is
// intentionally non-spendable so dev runs surface a clear "configure your
// wallet" error rather than silently sending USDC to a typo'd address.
//
// All tier rates are basis points (1 bp = 0.01%). MIN_TRADE_FOR_FEE skips
// fee on micro-trades where the on-chain transfer cost would dominate.

const env = import.meta.env || {}

function str(key, fallback) {
  const v = env[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

export const FEE_WALLET_PLACEHOLDER = 'PredictFLowFeeWa11etConfigureMeP1ease111111'

export const FEE_CONFIG = {
  FEE_WALLET: str('VITE_FEE_WALLET', FEE_WALLET_PLACEHOLDER),

  TIERS: {
    FREE: {
      key: 'FREE',
      label: 'Free',
      swapFeeBps: 30,
      conditionalOrders: 1,
      dcaEnabled: false,
      monthlyPriceUSDC: 0,
    },
    PRO: {
      key: 'PRO',
      label: 'Pro',
      swapFeeBps: 15,
      conditionalOrders: 10,
      dcaEnabled: true,
      monthlyPriceUSDC: 9.99,
    },
    WHALE: {
      key: 'WHALE',
      label: 'Whale',
      swapFeeBps: 5,
      conditionalOrders: Number.POSITIVE_INFINITY,
      dcaEnabled: true,
      monthlyPriceUSDC: 29.99,
    },
  },

  MIN_TRADE_FOR_FEE: 1.0,
  REFERRAL_SHARE_PERCENT: 20,
  SUBSCRIPTION_DAYS: 30,
}

export function isFeeWalletConfigured() {
  return !!FEE_CONFIG.FEE_WALLET && FEE_CONFIG.FEE_WALLET !== FEE_WALLET_PLACEHOLDER
}
