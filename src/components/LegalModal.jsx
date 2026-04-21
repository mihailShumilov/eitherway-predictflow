import React, { useState } from 'react'
import { X, FileText, Shield, AlertTriangle, ExternalLink } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { TERMS_URL, PRIVACY_URL, RISK_URL, SUPPORT_EMAIL } from '../config/env'

// Placeholder boilerplate. Before launch, replace the body of each tab
// with final text authored by counsel — the structure, headings, and
// cross-links below are safe to keep.
const TABS = [
  {
    key: 'terms',
    label: 'Terms of Service',
    icon: FileText,
    externalHref: TERMS_URL,
    sections: [
      {
        heading: 'Acceptance of terms',
        body: 'By accessing PredictFlow you agree to these terms. If you do not agree, do not use the service.',
      },
      {
        heading: 'Non-custodial frontend',
        body: 'PredictFlow is a non-custodial client-side interface. We do not hold funds, do not execute trades, and do not act as a broker, dealer, or exchange. Orders are routed to DFlow and settle against Kalshi, which is the CFTC-regulated counterparty of record.',
      },
      {
        heading: 'Eligibility and identity verification',
        body: 'Identity verification (KYC/AML) and trade eligibility are performed and enforced by DFlow and Kalshi — not by PredictFlow. You must be 18+ and located in a jurisdiction eligible for Kalshi event contracts. PredictFlow does not collect, store, or review KYC documents; the modal in this app links you to the upstream Proof flow operated by DFlow, and DFlow is the authority that approves or rejects each order.',
      },
      {
        heading: 'No financial advice',
        body: 'Prediction-market outcomes are speculative. Nothing on PredictFlow is investment, tax, or legal advice. You are solely responsible for your trades.',
      },
      {
        heading: 'Service availability',
        body: 'Order execution depends on tab connectivity, wallet availability, DFlow routing, and Solana network health. We make no uptime guarantees.',
      },
      {
        heading: 'Changes',
        body: 'We may update these terms. Continued use after changes constitutes acceptance.',
      },
    ],
  },
  {
    key: 'privacy',
    label: 'Privacy',
    icon: Shield,
    externalHref: PRIVACY_URL,
    sections: [
      {
        heading: 'What we collect',
        body: 'PredictFlow is a client-side app with no user database. Your wallet address is sent to DFlow for order execution and to Proof (operated by DFlow) for identity verification. PredictFlow itself does not receive, store, or transmit your KYC documents, personal identifiers, or verification status.',
      },
      {
        heading: 'What we store locally',
        body: 'Preferences, positions, DCA history, and a cached KYC-seen flag are stored in your browser (localStorage). The cached flag is a UX hint only — the authoritative verification check happens at DFlow. Clearing browser storage clears this data.',
      },
      {
        heading: 'Third parties',
        body: 'DFlow (order routing and KYC enforcement), Kalshi (settlement), Proof (identity verification, operated by DFlow), Solana RPC providers, and optional analytics/error-tracking vendors each have their own privacy policies. PredictFlow has no contractual access to data held by these parties.',
      },
    ],
  },
  {
    key: 'risk',
    label: 'Risk Disclosure',
    icon: AlertTriangle,
    externalHref: RISK_URL,
    sections: [
      {
        heading: 'You can lose money',
        body: 'Prediction markets resolve to $0 or $1. A losing position is worth zero. Only risk amounts you can afford to lose.',
      },
      {
        heading: 'Conditional orders are best-effort',
        body: 'Limit, stop-loss, and take-profit orders rely on this tab remaining open. Orders will not trigger if your browser is closed, backgrounded, or throttled. There is no server-side execution.',
      },
      {
        heading: 'Settlement timing',
        body: 'Markets settle according to Kalshi rules. Settlement can take hours. During the dispute window, positions remain unavailable for withdrawal.',
      },
      {
        heading: 'On-chain risk',
        body: 'Transactions sign against Solana. Network congestion, failed simulations, and stale blockhashes can cause submitted orders to fail even after signing. Review each signature request carefully.',
      },
      {
        heading: 'Eligibility rejections',
        body: 'DFlow and Kalshi can reject an order at any time — for KYC, jurisdiction, sanctions screening, or position-limit reasons. Rejections are surfaced in the trade panel with the upstream reason. PredictFlow has no ability to override or appeal those decisions.',
      },
    ],
  },
]

export default function LegalModal({ open, initialTab = 'terms', onClose }) {
  const [activeKey, setActiveKey] = useState(initialTab)
  const containerRef = useFocusTrap(open, onClose)

  if (!open) return null

  const active = TABS.find(t => t.key === activeKey) || TABS[0]
  const ActiveIcon = active.icon

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-modal-title"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={containerRef}
        className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl animate-slide-in"
      >
        <div className="px-6 pt-6 pb-4 border-b border-terminal-border flex items-start justify-between gap-3">
          <div>
            <h2 id="legal-modal-title" className="text-xl font-bold text-white tracking-tight">Legal &amp; Disclosures</h2>
            <p className="text-[11px] text-terminal-muted uppercase tracking-widest font-mono mt-0.5">
              Draft — pending counsel review
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 pt-3 border-b border-terminal-border">
          <div className="flex gap-1 overflow-x-auto -mx-2 px-2">
            {TABS.map(tab => {
              const Icon = tab.icon
              const activeTab = tab.key === active.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveKey(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap transition-all ${
                    activeTab
                      ? 'bg-terminal-card text-terminal-text border-b-2 border-terminal-accent'
                      : 'text-terminal-muted hover:text-terminal-text'
                  }`}
                >
                  <Icon size={12} />
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div className="flex items-center gap-2 text-sm text-white font-semibold">
            <ActiveIcon size={14} />
            {active.label}
          </div>
          {active.sections.map((section, i) => (
            <div key={i} className="space-y-1">
              <h3 className="text-[11px] uppercase tracking-widest text-terminal-muted font-semibold">
                {section.heading}
              </h3>
              <p className="text-sm text-terminal-text leading-relaxed">{section.body}</p>
            </div>
          ))}
          {active.externalHref && (
            <a
              href={active.externalHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-terminal-accent hover:text-terminal-cyan transition-colors"
            >
              Full {active.label.toLowerCase()}
              <ExternalLink size={10} />
            </a>
          )}
        </div>

        <div className="px-6 py-4 border-t border-terminal-border text-[11px] text-terminal-muted">
          Questions? {SUPPORT_EMAIL ? (
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-terminal-accent hover:text-terminal-cyan">
              {SUPPORT_EMAIL}
            </a>
          ) : (
            <span>Contact info pending.</span>
          )}
        </div>
      </div>
    </div>
  )
}
