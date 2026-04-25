import React from 'react'
import { Sparkles, Lock, ArrowRight } from 'lucide-react'

// Inline, contextual upsell banner. Two flavours: a plain nudge (right-arrow
// style) and a locked-overlay (`variant="lock"`) for gating entire features.
export default function UpgradeNudge({
  message,
  ctaLabel = 'Upgrade to Pro',
  onClick,
  variant = 'inline',
  tone = 'accent',
}) {
  if (variant === 'lock') {
    return (
      <div className="bg-terminal-card border border-terminal-border rounded-lg p-6 text-center space-y-3">
        <div className="w-10 h-10 rounded-full bg-terminal-accent/10 border border-terminal-accent/30 flex items-center justify-center mx-auto">
          <Lock size={16} className="text-terminal-accent" />
        </div>
        <p className="text-sm text-terminal-text">{message}</p>
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-terminal-accent text-white text-xs font-semibold rounded-lg hover:bg-blue-500 shadow-lg shadow-terminal-accent/20 transition-all"
        >
          <Sparkles size={12} />
          {ctaLabel}
        </button>
      </div>
    )
  }

  const toneClass = tone === 'yellow'
    ? 'bg-terminal-yellow/10 border-terminal-yellow/30 text-terminal-yellow hover:bg-terminal-yellow/15'
    : 'bg-terminal-accent/10 border-terminal-accent/30 text-terminal-accent hover:bg-terminal-accent/15'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-3 py-2 border rounded-lg text-xs transition-all ${toneClass}`}
    >
      <span className="flex items-center gap-2 text-left">
        <Sparkles size={12} />
        {message}
      </span>
      <span className="flex items-center gap-1 font-semibold shrink-0">
        {ctaLabel}
        <ArrowRight size={12} />
      </span>
    </button>
  )
}
