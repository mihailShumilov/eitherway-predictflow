import React, { useState } from 'react'
import { X, ShieldCheck, ExternalLink, Check, Info } from 'lucide-react'
import { useKyc } from '../hooks/useKyc'

const PROOF_VERIFY_URL = 'https://www.dflow.net/proof'

export default function KycModal() {
  const { showModal, setShowModal, status, markPending, markVerified } = useKyc()
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)

  if (!showModal) return null

  const handleVerify = () => {
    markPending()
    setAwaitingConfirm(true)
    window.open(PROOF_VERIFY_URL, '_blank', 'noopener,noreferrer')
  }

  const handleDismiss = () => {
    setShowModal(false)
    setAwaitingConfirm(false)
  }

  const handleConfirmVerified = () => {
    markVerified()
    setAwaitingConfirm(false)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleDismiss}
      />
      <div className="relative w-full max-w-md bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl overflow-hidden animate-slide-in">
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-terminal-accent to-terminal-cyan flex items-center justify-center shrink-0">
              <ShieldCheck size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                Identity Verification Required
              </h2>
              <p className="text-[11px] text-terminal-muted uppercase tracking-widest font-mono">
                Proof · Powered by DFlow
              </p>
            </div>
          </div>

          <p className="text-sm text-terminal-text leading-relaxed mb-3">
            DFlow prediction markets are powered by <span className="text-white font-semibold">Kalshi</span>, a CFTC-regulated exchange. You need to verify your identity before trading.
          </p>

          <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 mb-4 space-y-2 text-xs text-terminal-muted">
            <div className="flex items-start gap-2">
              <Check size={14} className="text-terminal-green mt-0.5 shrink-0" />
              <span>One-time verification unlocks all trading features</span>
            </div>
            <div className="flex items-start gap-2">
              <Check size={14} className="text-terminal-green mt-0.5 shrink-0" />
              <span>Browsing markets, charts, and search remain open</span>
            </div>
            <div className="flex items-start gap-2">
              <Check size={14} className="text-terminal-green mt-0.5 shrink-0" />
              <span>Your KYC is handled by Proof — PredictFlow never sees your documents</span>
            </div>
          </div>

          {status === 'pending' && awaitingConfirm && (
            <div className="flex items-start gap-2 bg-terminal-accent/10 border border-terminal-accent/30 rounded-lg p-3 mb-4 text-xs text-terminal-accent">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                Finished verifying on Proof? Click <span className="font-semibold">I've verified</span> to unlock trading.
              </span>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 space-y-2">
          {awaitingConfirm ? (
            <button
              onClick={handleConfirmVerified}
              className="w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm bg-terminal-green hover:bg-emerald-500 text-white shadow-lg shadow-terminal-green/20 transition-all flex items-center justify-center gap-2"
            >
              <Check size={16} />
              I've verified with Proof
            </button>
          ) : (
            <button
              onClick={handleVerify}
              className="w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm bg-gradient-to-r from-terminal-accent to-terminal-cyan hover:opacity-90 text-white shadow-lg shadow-terminal-accent/20 transition-all flex items-center justify-center gap-2"
            >
              <ShieldCheck size={16} />
              Verify with Proof
              <ExternalLink size={14} />
            </button>
          )}
          <button
            onClick={handleDismiss}
            className="w-full py-2.5 min-h-[44px] rounded-lg font-medium text-sm bg-terminal-card hover:bg-terminal-highlight text-terminal-muted hover:text-terminal-text transition-all"
          >
            Continue browsing
          </button>
        </div>

        <div className="px-6 pb-4 pt-2 border-t border-terminal-border">
          <p className="text-[10px] text-terminal-muted leading-relaxed">
            Trading is restricted to verified users in eligible jurisdictions. By continuing you acknowledge that prediction-market outcomes are final and that funds may be at risk.
          </p>
        </div>
      </div>
    </div>
  )
}
