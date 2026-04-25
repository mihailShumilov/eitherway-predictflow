import React from 'react'
import { Check, Crown, Sparkles, Star } from 'lucide-react'
import { FEE_CONFIG } from '../../config/fees'
import { useUserTier } from '../../hooks/useUserTier'

const TIERS = [
  {
    key: 'FREE',
    headline: 'Free',
    icon: Star,
    accent: 'text-terminal-muted',
    badge: null,
    features: [
      'Live market data + charts',
      '1 active conditional order',
      'Standard execution',
      `${FEE_CONFIG.TIERS.FREE.swapFeeBps / 100}% trading fee`,
    ],
    cta: 'Current Plan',
    disabled: true,
    border: 'border-terminal-border',
    glow: '',
  },
  {
    key: 'PRO',
    headline: 'Pro',
    icon: Sparkles,
    accent: 'text-terminal-accent',
    badge: 'MOST POPULAR',
    features: [
      'Everything in Free',
      'Up to 10 conditional orders',
      'DCA strategies',
      `${FEE_CONFIG.TIERS.PRO.swapFeeBps / 100}% trading fee (50% off)`,
      'Priority support',
    ],
    cta: 'Upgrade to Pro',
    border: 'border-terminal-accent/60',
    glow: 'shadow-lg shadow-terminal-accent/20',
  },
  {
    key: 'WHALE',
    headline: 'Whale',
    icon: Crown,
    accent: 'text-terminal-yellow',
    badge: null,
    features: [
      'Everything in Pro',
      'Unlimited conditional orders',
      `${FEE_CONFIG.TIERS.WHALE.swapFeeBps / 100}% trading fee`,
      'Priority execution',
    ],
    cta: 'Upgrade to Whale',
    border: 'border-terminal-yellow/40',
    glow: 'shadow-md shadow-terminal-yellow/10',
  },
]

export default function PricingCards({ onSelectTier }) {
  const { tier: currentTier } = useUserTier()

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {TIERS.map(t => {
        const config = FEE_CONFIG.TIERS[t.key]
        const Icon = t.icon
        const isCurrent = currentTier === t.key
        const ctaLabel = isCurrent
          ? 'Current Plan'
          : t.disabled
            ? 'Free for everyone'
            : t.cta

        return (
          <div
            key={t.key}
            className={`relative bg-terminal-surface border ${t.border} rounded-xl p-6 flex flex-col ${t.glow} ${
              t.key === 'PRO' ? 'md:scale-[1.02]' : ''
            }`}
          >
            {t.badge && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-terminal-accent text-white text-[10px] font-bold uppercase tracking-wider rounded-full">
                {t.badge}
              </div>
            )}

            <div className="flex items-center gap-2 mb-4">
              <Icon size={20} className={t.accent} />
              <h3 className={`text-xl font-bold ${t.accent}`}>{t.headline}</h3>
            </div>

            <div className="mb-4">
              {config.monthlyPriceUSDC > 0 ? (
                <div>
                  <span className="text-3xl font-bold text-terminal-text">
                    ${config.monthlyPriceUSDC}
                  </span>
                  <span className="text-sm text-terminal-muted ml-1">/mo USDC</span>
                </div>
              ) : (
                <div>
                  <span className="text-3xl font-bold text-terminal-text">$0</span>
                  <span className="text-sm text-terminal-muted ml-1">forever</span>
                </div>
              )}
            </div>

            <ul className="space-y-2 mb-6 flex-1">
              {t.features.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-terminal-text">
                  <Check size={14} className="mt-0.5 shrink-0 text-terminal-green" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              disabled={isCurrent || t.disabled}
              onClick={() => onSelectTier?.(t.key)}
              className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-all ${
                isCurrent || t.disabled
                  ? 'bg-terminal-card text-terminal-muted cursor-not-allowed border border-terminal-border'
                  : t.key === 'PRO'
                    ? 'bg-terminal-accent text-white hover:bg-blue-500 shadow-lg shadow-terminal-accent/20'
                    : 'bg-terminal-yellow text-black hover:bg-yellow-400 shadow-lg shadow-terminal-yellow/20'
              }`}
            >
              {ctaLabel}
            </button>
          </div>
        )
      })}
    </div>
  )
}
