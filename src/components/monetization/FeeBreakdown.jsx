import React from 'react'
import { Info, ArrowRight } from 'lucide-react'

// Pre-trade transparency block: shows the input/fee/net split so the user
// sees exactly what's being deducted before signing. Free users get an
// inline upgrade nudge with the next tier's effective fee.
export default function FeeBreakdown({ quote, onUpgradeClick }) {
  if (!quote || quote.error) return null
  if (!Number.isFinite(quote.inputAmount)) return null

  const showUpgrade = quote.tier === 'FREE' && quote.inputAmount > 0
  const feePercent = (quote.feeBps / 100).toFixed(2)
  const hasReferral = quote.referralAmount > 0

  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-terminal-muted">
        <span>Trade Summary</span>
        <span className="font-mono">{quote.tier}</span>
      </div>

      <Row label="You pay" value={`$${quote.inputAmount.toFixed(2)} USDC`} />
      <Row
        label={
          <span className="flex items-center gap-1" title="PredictFlow platform fee">
            PredictFlow fee
            <Info size={10} className="text-terminal-muted/60" />
          </span>
        }
        value={
          quote.feeAmount > 0
            ? `−$${quote.feeAmount.toFixed(4)} (${feePercent}%)`
            : 'Waived'
        }
        valueClass="font-mono text-terminal-yellow"
      />
      {hasReferral && (
        <Row
          label={<span className="pl-2 text-terminal-muted/80">↳ Referrer share (20%)</span>}
          value={`$${quote.referralAmount.toFixed(4)}`}
          valueClass="font-mono text-terminal-cyan"
        />
      )}
      <Row
        label="Trade amount"
        value={`$${quote.netAmount.toFixed(4)} USDC`}
        valueClass="font-mono text-terminal-text font-semibold"
      />
      <Row
        label="Est. output"
        value={`${quote.outputAmount} shares`}
        valueClass="font-mono text-terminal-green"
      />

      {showUpgrade && (
        <button
          type="button"
          onClick={onUpgradeClick}
          className="w-full mt-2 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-terminal-accent/10 border border-terminal-accent/30 hover:bg-terminal-accent/15 hover:border-terminal-accent/50 transition-all text-[11px] text-terminal-accent"
        >
          <span>Upgrade to Pro for 0.15% fee</span>
          <ArrowRight size={12} />
        </button>
      )}
    </div>
  )
}

function Row({ label, value, valueClass = 'font-mono text-terminal-text' }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-terminal-muted">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  )
}
