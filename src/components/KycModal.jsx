import React, { useState } from 'react'
import { X, ShieldCheck, ExternalLink, Check, Info } from 'lucide-react'
import { useKyc } from '../hooks/useKyc'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useLegalModal } from '../hooks/useLegalModal'
import { PROOF_URL } from '../config/env'
import { track } from '../lib/analytics'

// Reject anything that doesn't look like an https URL on a known host.
// Prevents a misconfigured env from sending users to a phishing page.
function validatedProofUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    // Allow *.dflow.net, *.proof.* or a prod-specific host. Keep permissive
    // enough for staging but reject obvious bait (e.g. dflow.net.evil.tld).
    const host = u.hostname.toLowerCase()
    if (host === 'dflow.net' || host.endsWith('.dflow.net')) return u.toString()
    if (host === 'proof.com' || host.endsWith('.proof.com')) return u.toString()
    return null
  } catch {
    return null
  }
}

const PROOF_VERIFY_URL = validatedProofUrl(PROOF_URL)

export default function KycModal() {
  const { showModal, setShowModal, status, reason, markPending, markVerified } = useKyc()
  const { openLegal } = useLegalModal()
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)

  const handleDismiss = () => {
    track('kyc_modal_dismissed', { status, awaiting_confirm: awaitingConfirm, had_reason: !!reason })
    setShowModal(false)
    setAwaitingConfirm(false)
  }

  const containerRef = useFocusTrap(showModal, handleDismiss)

  if (!showModal) return null

  const handleVerify = () => {
    if (!PROOF_VERIFY_URL) return
    track('kyc_verification_started')
    markPending()
    setAwaitingConfirm(true)
    window.open(PROOF_VERIFY_URL, '_blank', 'noopener,noreferrer')
  }

  const handleConfirmVerified = () => {
    track('kyc_marked_verified', { source: 'self_attestation' })
    markVerified()
    setAwaitingConfirm(false)
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kyc-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleDismiss}
      />
      <div
        ref={containerRef}
        className="relative w-full max-w-md bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl overflow-hidden animate-slide-in"
      >
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
              <h2 id="kyc-modal-title" className="text-base font-semibold text-white">
                Identity Verification Required
              </h2>
              <p className="text-[11px] text-terminal-muted uppercase tracking-widest font-mono">
                Proof · Powered by DFlow
              </p>
            </div>
          </div>

          <p className="text-sm text-terminal-text leading-relaxed mb-3">
            DFlow prediction markets settle against <span className="text-white font-semibold">Kalshi</span>, a CFTC-regulated exchange. DFlow requires identity verification via Proof before routing your trades — PredictFlow is a non-custodial frontend and does not see your KYC documents.
          </p>

          {reason && (
            <div className="flex items-start gap-2 bg-terminal-red/10 border border-terminal-red/30 rounded-lg p-3 mb-3 text-xs text-terminal-red">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold">DFlow rejected this order:</span> {reason}
              </span>
            </div>
          )}

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
          {!PROOF_VERIFY_URL && (
            <div className="flex items-start gap-2 bg-terminal-red/10 border border-terminal-red/30 rounded-lg p-2.5 text-xs text-terminal-red">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>Proof URL is not configured or failed validation. Contact support.</span>
            </div>
          )}
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
              disabled={!PROOF_VERIFY_URL}
              className="w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm bg-gradient-to-r from-terminal-accent to-terminal-cyan hover:opacity-90 text-white shadow-lg shadow-terminal-accent/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
            Trading is restricted to verified users in eligible jurisdictions. By continuing you acknowledge the{' '}
            <button
              type="button"
              onClick={() => openLegal('terms')}
              className="text-terminal-accent hover:text-terminal-cyan underline-offset-2 hover:underline"
            >
              terms
            </button>
            ,{' '}
            <button
              type="button"
              onClick={() => openLegal('privacy')}
              className="text-terminal-accent hover:text-terminal-cyan underline-offset-2 hover:underline"
            >
              privacy policy
            </button>
            , and{' '}
            <button
              type="button"
              onClick={() => openLegal('risk')}
              className="text-terminal-accent hover:text-terminal-cyan underline-offset-2 hover:underline"
            >
              risk disclosures
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
