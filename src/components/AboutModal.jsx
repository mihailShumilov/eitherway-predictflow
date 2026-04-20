import React from 'react'
import {
  X, Activity, Target, TrendingDown, TrendingUp, Repeat,
  BookOpen, ExternalLink, Zap, ShieldCheck
} from 'lucide-react'

const DFLOW_DOCS_URL = 'https://docs.dflow.net'

const FEATURES = [
  {
    icon: Target,
    title: 'Limit Orders',
    body: 'Place orders at a target price. Executes automatically when the market reaches your limit.',
  },
  {
    icon: TrendingDown,
    title: 'Stop-Loss',
    body: 'Cap your downside. Exits a position if the price drops below your trigger.',
  },
  {
    icon: TrendingUp,
    title: 'Take-Profit',
    body: 'Lock in gains. Exits a position when the price hits your target.',
  },
  {
    icon: Repeat,
    title: 'DCA Strategies',
    body: 'Build a position gradually. Schedule recurring buys across a budget.',
  },
]

const INTEGRATIONS = [
  'Event & market discovery',
  'Real-time order book & depth',
  'Candlestick history',
  'Quote & order execution',
  'Outcome-mint resolution',
  'Portfolio reconciliation',
]

export default function AboutModal({ open, onClose }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl animate-slide-in">
        <button
          onClick={onClose}
          className="sticky top-3 float-right mr-3 p-1.5 rounded-lg text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all z-10"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="px-6 pt-6 pb-4 border-b border-terminal-border">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-terminal-accent to-terminal-cyan flex items-center justify-center shrink-0">
              <Activity size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">About PredictFlow</h2>
              <p className="text-[11px] text-terminal-muted uppercase tracking-widest font-mono">
                DFlow Terminal · v1.0
              </p>
            </div>
          </div>

          <p className="text-sm text-terminal-text leading-relaxed">
            The first conditional trading terminal for prediction markets on Solana.
          </p>
          <p className="text-xs text-terminal-muted leading-relaxed mt-2">
            PredictFlow brings professional order types to event-driven markets — limit, stop-loss, take-profit, and dollar-cost averaging — with live pricing, order-book depth, and on-chain settlement.
          </p>
        </div>

        <div className="px-6 py-5 border-b border-terminal-border">
          <h3 className="text-[11px] font-semibold text-terminal-muted uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Zap size={11} />
            How it works
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FEATURES.map(f => {
              const Icon = f.icon
              return (
                <div key={f.title} className="flex items-start gap-3 p-3 bg-terminal-card border border-terminal-border rounded-lg">
                  <div className="w-8 h-8 shrink-0 rounded-md bg-terminal-highlight flex items-center justify-center text-terminal-accent">
                    <Icon size={14} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-terminal-text">{f.title}</p>
                    <p className="text-[11px] text-terminal-muted leading-relaxed mt-0.5">{f.body}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="px-6 py-5 border-b border-terminal-border">
          <h3 className="text-[11px] font-semibold text-terminal-muted uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <BookOpen size={11} />
            Integration
          </h3>
          <p className="text-xs text-terminal-text leading-relaxed">
            Built on the DFlow Prediction Markets API, using 15+ endpoints for market data, execution, and real-time streaming.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
            {INTEGRATIONS.map(item => (
              <div key={item} className="text-[11px] font-mono text-terminal-muted flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-terminal-accent shrink-0" />
                <span className="truncate">{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-5 border-b border-terminal-border">
          <h3 className="text-[11px] font-semibold text-terminal-muted uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <ShieldCheck size={11} />
            Regulated exposure
          </h3>
          <p className="text-xs text-terminal-text leading-relaxed">
            Markets route to <span className="text-white font-semibold">Kalshi</span>, a CFTC-regulated exchange. Trading requires one-time identity verification via Proof. Browsing, charts, and research are always open.
          </p>
        </div>

        <div className="px-6 py-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <a
            href={DFLOW_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg font-semibold text-sm bg-gradient-to-r from-terminal-accent to-terminal-cyan hover:opacity-90 text-white shadow-lg shadow-terminal-accent/20 transition-all"
          >
            <BookOpen size={14} />
            DFlow Docs
            <ExternalLink size={12} />
          </a>
          <button
            onClick={onClose}
            className="flex-1 py-2.5 min-h-[44px] rounded-lg font-medium text-sm bg-terminal-card hover:bg-terminal-highlight text-terminal-muted hover:text-terminal-text transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
