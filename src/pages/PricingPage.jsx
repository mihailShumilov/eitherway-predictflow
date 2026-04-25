import React, { useState } from 'react'
import { Sparkles, Shield, Zap } from 'lucide-react'
import PricingCards from '../components/monetization/PricingCards'
import UpgradeModal from '../components/monetization/UpgradeModal'
import FeeDisclosure from '../components/monetization/FeeDisclosure'
import { useUserTier } from '../hooks/useUserTier'

const FAQ = [
  {
    q: 'How are fees collected?',
    a: 'Each trade triggers a small SPL USDC transfer from your wallet to PredictFlow’s fee wallet. The amount is shown in the trade summary before you sign — fully transparent, fully non-custodial.',
  },
  {
    q: 'Can I cancel my subscription?',
    a: 'Yes. Subscriptions auto-expire after 30 days. To stop renewing, simply don’t pay for the next cycle — your tier reverts to Free with no further charges.',
  },
  {
    q: 'What happens to my conditional orders if I downgrade?',
    a: 'Existing orders keep running. New orders beyond the Free-tier limit (1 active order) won’t place until earlier ones fill or are cancelled.',
  },
  {
    q: 'Is the fee separate from DFlow’s execution fee?',
    a: 'Yes. PredictFlow’s fee is on top of DFlow’s on-chain execution (router fees, network fees). You see all of them in the trade summary before signing.',
  },
]

export default function PricingPage({ onPageChange }) {
  const { tier } = useUserTier()
  const [selectedTier, setSelectedTier] = useState(null)

  return (
    <div className="space-y-10 py-6">
      <div className="text-center max-w-2xl mx-auto space-y-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-terminal-accent/10 border border-terminal-accent/30 rounded-full text-[11px] uppercase tracking-widest text-terminal-accent font-semibold">
          <Sparkles size={12} />
          Pricing
        </span>
        <h1 className="text-3xl font-bold text-white">
          Trade smarter. Pay less.
        </h1>
        <p className="text-sm text-terminal-muted">
          Start free, upgrade when you need DCA strategies, more conditional orders,
          and a meaningful fee discount. Cancel anytime — wallet stays in your control.
        </p>
      </div>

      <PricingCards onSelectTier={setSelectedTier} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Feature
          icon={Shield}
          title="Non-custodial"
          body="Every trade is a wallet-signed transaction. We never hold your funds."
        />
        <Feature
          icon={Zap}
          title="Predictable fees"
          body="Flat per-tier rate disclosed in the trade summary. No hidden spread."
        />
        <Feature
          icon={Sparkles}
          title="Real upgrades"
          body="Subscribe in USDC; tier activates instantly on transaction confirm."
        />
      </div>

      <div className="bg-terminal-surface border border-terminal-border rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Frequently asked questions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {FAQ.map((item, i) => (
            <div key={i}>
              <h3 className="text-sm font-semibold text-terminal-text mb-1">{item.q}</h3>
              <p className="text-xs text-terminal-muted leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      <FeeDisclosure />

      <UpgradeModal
        open={!!selectedTier && selectedTier !== tier && selectedTier !== 'FREE'}
        tier={selectedTier}
        onClose={() => setSelectedTier(null)}
        onSuccess={() => {
          setSelectedTier(null)
          onPageChange?.('explore')
        }}
      />
    </div>
  )
}

function Feature({ icon: Icon, title, body }) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
      <div className="w-8 h-8 rounded-lg bg-terminal-accent/10 border border-terminal-accent/30 flex items-center justify-center mb-2">
        <Icon size={14} className="text-terminal-accent" />
      </div>
      <h3 className="text-sm font-semibold text-terminal-text mb-1">{title}</h3>
      <p className="text-xs text-terminal-muted leading-relaxed">{body}</p>
    </div>
  )
}
