import React from 'react'
import { Clock, TrendingUp, DollarSign, Zap } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

function formatUsd(num) {
  if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`
  if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`
  return `$${num.toFixed(0)}`
}

function priceToPercent(price) {
  return `${(price * 100).toFixed(0)}¢`
}

function getUrgencyColor(closeTime) {
  const hours = (new Date(closeTime) - Date.now()) / 3600000
  if (hours < 4) return 'text-terminal-red'
  if (hours < 24) return 'text-terminal-yellow'
  return 'text-terminal-muted'
}

export default function MarketCard({ market, onSelect }) {
  const timeLeft = formatDistanceToNow(new Date(market.closeTime), { addSuffix: true })
  const urgencyColor = getUrgencyColor(market.closeTime)
  const yesPercent = (market.yesAsk * 100).toFixed(0)
  const noPercent = (market.noAsk * 100).toFixed(0)

  return (
    <div
      onClick={() => onSelect(market)}
      className="bg-terminal-surface border border-terminal-border rounded-lg p-4 hover:border-terminal-accent/50 hover:bg-terminal-card transition-all duration-200 cursor-pointer group"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-terminal-muted mb-1 truncate">{market.eventTitle}</p>
          <h3 className="text-sm font-medium text-terminal-text group-hover:text-white transition-colors leading-snug">
            {market.question}
          </h3>
        </div>
        <span className={`shrink-0 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-terminal-card border border-terminal-border ${
          market.category === 'Sports' ? 'text-terminal-green' :
          market.category === 'Crypto' ? 'text-terminal-yellow' :
          market.category === 'Politics' ? 'text-terminal-cyan' :
          'text-terminal-red'
        }`}>
          {market.category}
        </span>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 h-2 bg-terminal-card rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-terminal-green to-emerald-400 rounded-full transition-all duration-500"
            style={{ width: `${yesPercent}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          onClick={(e) => { e.stopPropagation(); onSelect({ ...market, side: 'yes' }) }}
          className="flex items-center justify-between px-3 py-2 bg-terminal-green/10 border border-terminal-green/30 rounded-lg hover:bg-terminal-green/20 hover:border-terminal-green/50 transition-all group/btn"
        >
          <span className="text-xs font-semibold text-terminal-green">YES</span>
          <span className="text-sm font-mono font-bold text-terminal-green">
            {priceToPercent(market.yesAsk)}
          </span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect({ ...market, side: 'no' }) }}
          className="flex items-center justify-between px-3 py-2 bg-terminal-red/10 border border-terminal-red/30 rounded-lg hover:bg-terminal-red/20 hover:border-terminal-red/50 transition-all group/btn"
        >
          <span className="text-xs font-semibold text-terminal-red">NO</span>
          <span className="text-sm font-mono font-bold text-terminal-red">
            {priceToPercent(market.noAsk)}
          </span>
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-terminal-muted">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <TrendingUp size={12} />
            {formatUsd(market.volume)}
          </span>
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            {formatUsd(market.liquidity)}
          </span>
        </div>
        <span className={`flex items-center gap-1 ${urgencyColor}`}>
          <Clock size={12} />
          {timeLeft}
        </span>
      </div>
    </div>
  )
}
