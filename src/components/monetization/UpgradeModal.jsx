import React, { useEffect, useState } from 'react'
import { X, Sparkles, Crown, AlertCircle, Loader2, Check, Wallet } from 'lucide-react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useWallet } from '../../hooks/useWallet'
import { useUserTier } from '../../hooks/useUserTier'
import { FEE_CONFIG, isFeeWalletConfigured } from '../../config/fees'
import { USDC_MINT } from '../../config/env'
import { buildFeeTransferTransaction } from '../../lib/feeTransfer'
import { logFeeEvent } from '../../lib/feeLog'
import { reportError } from '../../lib/errorReporter'
import { safeErrorMessage } from '../../lib/errorMessage'

// Subscription payment: transfer monthly fee in USDC from the connected
// wallet to FEE_WALLET, then persist the tier+expiry in localStorage.
// Build runs only once the user clicks Pay; if they cancel the wallet
// popup the modal stays open.
export default function UpgradeModal({ open, tier, onClose, onSuccess }) {
  const { connected, connect, address, activeWallet } = useWallet()
  const { upgradeTier } = useUserTier()
  const [status, setStatus] = useState('idle') // idle | signing | success | error
  const [error, setError] = useState(null)

  const containerRef = useFocusTrap(open, () => {
    if (status !== 'signing') onClose?.()
  })

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }
  }, [open, tier])

  if (!open || !tier) return null

  const tierConfig = FEE_CONFIG.TIERS[tier]
  if (!tierConfig) return null

  const Icon = tier === 'WHALE' ? Crown : Sparkles
  const accentClass = tier === 'WHALE' ? 'text-terminal-yellow' : 'text-terminal-accent'
  const bgClass = tier === 'WHALE'
    ? 'from-terminal-yellow to-yellow-600'
    : 'from-terminal-accent to-terminal-cyan'

  const handlePay = async () => {
    if (!connected) { connect(); return }
    if (!isFeeWalletConfigured()) {
      setStatus('error')
      setError('Subscription wallet not configured. Set VITE_FEE_WALLET in your environment.')
      return
    }
    setStatus('signing')
    setError(null)
    try {
      const provider = activeWallet?.getProvider?.()
      if (!provider) throw new Error('No wallet provider — please reconnect')

      const built = await buildFeeTransferTransaction({
        fromPubkey: address,
        mint: USDC_MINT,
        transfers: [{
          toPubkey: FEE_CONFIG.FEE_WALLET,
          amountLamports: Math.floor(tierConfig.monthlyPriceUSDC * 1e6),
          label: `subscription:${tier}`,
        }],
      })
      if (!built) throw new Error('Could not build subscription transaction')

      if (typeof provider.signAndSendTransaction === 'function') {
        await provider.signAndSendTransaction(built.tx)
      } else if (typeof provider.signTransaction === 'function') {
        await provider.signTransaction(built.tx)
      } else {
        throw new Error('Wallet does not support signing')
      }

      upgradeTier(tier, { months: 1 })
      logFeeEvent({
        kind: 'subscription',
        tier,
        platformAmount: tierConfig.monthlyPriceUSDC,
        feeAmount: tierConfig.monthlyPriceUSDC,
      })
      setStatus('success')
      setTimeout(() => onSuccess?.(tier), 800)
    } catch (err) {
      reportError(err, { context: 'subscription', tier })
      setStatus('error')
      setError(safeErrorMessage(err, 'Payment failed'))
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upgrade-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => status !== 'signing' && onClose?.()}
      />
      <div
        ref={containerRef}
        className="relative w-full max-w-md bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl overflow-hidden animate-slide-in"
      >
        <button
          onClick={() => status !== 'signing' && onClose?.()}
          disabled={status === 'signing'}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all disabled:opacity-50"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${bgClass} flex items-center justify-center shrink-0`}>
              <Icon size={20} className="text-white" />
            </div>
            <div>
              <h2 id="upgrade-modal-title" className="text-base font-semibold text-white">
                Upgrade to {tierConfig.label}
              </h2>
              <p className="text-[11px] text-terminal-muted uppercase tracking-widest font-mono">
                ${tierConfig.monthlyPriceUSDC} / month · USDC
              </p>
            </div>
          </div>

          <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-1.5 text-xs mb-4">
            <Row label="Plan" value={tierConfig.label} />
            <Row label="Trading fee" value={`${(tierConfig.swapFeeBps / 100).toFixed(2)}%`} valueClass={`font-mono ${accentClass}`} />
            <Row
              label="Conditional orders"
              value={Number.isFinite(tierConfig.conditionalOrders) ? `${tierConfig.conditionalOrders} max` : 'Unlimited'}
            />
            <Row label="DCA strategies" value={tierConfig.dcaEnabled ? 'Included' : 'Not included'} />
            <Row label="Billing cycle" value={`${FEE_CONFIG.SUBSCRIPTION_DAYS} days`} />
          </div>

          {!isFeeWalletConfigured() && (
            <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-3 mb-3 text-xs text-terminal-yellow">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>
                Demo build — fee wallet is not configured. Production deployment requires
                <code className="font-mono ml-1">VITE_FEE_WALLET</code> set to your Solana pubkey.
              </span>
            </div>
          )}

          {status === 'error' && error && (
            <div className="flex items-start gap-2 bg-terminal-red/10 border border-terminal-red/30 rounded-lg p-3 mb-3 text-xs text-terminal-red">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {status === 'success' && (
            <div className="flex items-start gap-2 bg-terminal-green/10 border border-terminal-green/30 rounded-lg p-3 mb-3 text-xs text-terminal-green">
              <Check size={12} className="mt-0.5 shrink-0" />
              <span>Subscription active — enjoy {tierConfig.label}.</span>
            </div>
          )}

          <button
            onClick={handlePay}
            disabled={status === 'signing' || status === 'success'}
            className={`w-full py-3 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
              tier === 'WHALE'
                ? 'bg-terminal-yellow text-black hover:bg-yellow-400 shadow-lg shadow-terminal-yellow/20'
                : 'bg-terminal-accent text-white hover:bg-blue-500 shadow-lg shadow-terminal-accent/20'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {status === 'signing' ? (
              <><Loader2 size={14} className="animate-spin" /> Signing transaction…</>
            ) : status === 'success' ? (
              <><Check size={14} /> Activated</>
            ) : !connected ? (
              <><Wallet size={14} /> Connect Wallet to Pay</>
            ) : (
              <>Pay ${tierConfig.monthlyPriceUSDC} USDC</>
            )}
          </button>

          <p className="text-[10px] text-terminal-muted mt-3 text-center">
            Payment is a single SPL token transfer to PredictFlow's fee wallet. Cancel anytime — your wallet stays in your control.
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, valueClass = 'font-mono text-terminal-text' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-terminal-muted">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  )
}
