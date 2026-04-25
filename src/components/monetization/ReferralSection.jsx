import React, { useState } from 'react'
import { Copy, Check, Share2, Users, DollarSign } from 'lucide-react'
import { useWallet } from '../../hooks/useWallet'
import { useReferral } from '../../hooks/useReferral'
import { FEE_CONFIG } from '../../config/fees'

export default function ReferralSection() {
  const { connected } = useWallet()
  const { code, link, stats } = useReferral()
  const [copied, setCopied] = useState(false)

  if (!connected) return null

  const handleCopy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // older browsers — fall back to selection prompt
      window.prompt('Copy your referral link', link)
    }
  }

  const handleShare = async () => {
    if (!link || typeof navigator?.share !== 'function') return handleCopy()
    try {
      await navigator.share({
        title: 'PredictFlow',
        text: `Trade Kalshi prediction markets on Solana with my link — ${FEE_CONFIG.REFERRAL_SHARE_PERCENT}% fee discount supports me too.`,
        url: link,
      })
    } catch { /* user dismissed share sheet */ }
  }

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center gap-2">
        <Share2 size={12} className="text-terminal-cyan" />
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Invite friends, earn {FEE_CONFIG.REFERRAL_SHARE_PERCENT}% of their fees
        </h3>
      </div>

      <div className="p-4 space-y-3">
        <p className="text-xs text-terminal-text">
          Share your referral link. When friends trade on PredictFlow, you earn{' '}
          <span className="text-terminal-cyan font-semibold">{FEE_CONFIG.REFERRAL_SHARE_PERCENT}%</span>{' '}
          of every fee — paid directly to your wallet in USDC.
        </p>

        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 bg-terminal-card border border-terminal-border rounded-lg font-mono text-xs text-terminal-text overflow-hidden">
            <span className="block truncate" title={link}>{link || '—'}</span>
          </div>
          <button
            onClick={handleCopy}
            className="px-3 py-2 bg-terminal-card border border-terminal-border rounded-lg text-xs text-terminal-muted hover:text-terminal-text hover:border-terminal-accent transition-all flex items-center gap-1"
          >
            {copied ? <Check size={12} className="text-terminal-green" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <button
              onClick={handleShare}
              className="px-3 py-2 bg-terminal-accent text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-all flex items-center gap-1"
            >
              <Share2 size={12} />
              Share
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Stat icon={Users} label="Referrals" value={stats.count} />
          <Stat icon={DollarSign} label="Total earned" value={`$${stats.earned.toFixed(2)}`} tone="text-terminal-cyan" />
        </div>

        <p className="text-[10px] text-terminal-muted">
          Your code: <span className="font-mono text-terminal-text">{code || '—'}</span>
        </p>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value, tone = 'text-terminal-text' }) {
  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-terminal-muted uppercase tracking-wider mb-1">
        <Icon size={10} />
        {label}
      </div>
      <div className={`text-lg font-mono font-semibold ${tone}`}>{value}</div>
    </div>
  )
}
