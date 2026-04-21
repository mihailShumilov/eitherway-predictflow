import React from 'react'
import { Clock, TrendingUp, DollarSign, ArrowUp, ArrowDown, Lock } from 'lucide-react'
import { formatMarketClose } from '../lib/dateFormat'
import { formatUsd, priceToPercent } from '../lib/format'
import { usePriceFlash } from '../hooks/useLivePrices'

function getUrgencyColor(closeTime) {
  const hours = (new Date(closeTime) - Date.now()) / 3600000
  if (hours < 4) return 'text-terminal-red'
  if (hours < 24) return 'text-terminal-yellow'
  return 'text-terminal-muted'
}

export default function MarketCard({ market, onSelect }) {
  const closeLabel = formatMarketClose(market.closeTime)
  const urgencyColor = getUrgencyColor(market.closeTime)
  const yesPercent = (market.yesAsk * 100).toFixed(0)
  const noPercent = (market.noAsk * 100).toFixed(0)
  const isClosed = new Date(market.closeTime).getTime() <= Date.now()
  const flash = usePriceFlash(market.id, market.yesAsk, market.noAsk)

  const flashClass = flash === 'up'
    ? 'animate-flash-green'
    : flash === 'down'
      ? 'animate-flash-red'
      : ''

  return (
    <div
      onClick={() => onSelect(market)}
      className={`relative bg-terminal-surface border border-terminal-border rounded-lg p-4 hover:border-terminal-accent/50 hover:bg-terminal-card hover:-translate-y-0.5 hover:shadow-lg hover:shadow-terminal-accent/5 transition-all duration-200 cursor-pointer group ${flashClass}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-terminal-muted mb-1 truncate">{market.eventTitle}</p>
          <h3 className="text-sm font-medium text-terminal-text group-hover:text-white transition-colors leading-snug">
            {market.question}
          </h3>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-terminal-card border border-terminal-border ${
            market.category === 'Sports' ? 'text-terminal-green' :
            market.category === 'Crypto' ? 'text-terminal-yellow' :
            market.category === 'Politics' ? 'text-terminal-cyan' :
            'text-terminal-red'
          }`}>
            {market.category}
          </span>
          {isClosed && (
            <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-terminal-muted/10 border border-terminal-muted/40 text-terminal-muted">
              <Lock size={9} />
              Closed
            </span>
          )}
        </div>
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
          onClick={(e) => { e.stopPropagation(); if (!isClosed) onSelect({ ...market, side: 'yes' }) }}
          disabled={isClosed}
          className="flex items-center justify-between px-3 py-2 min-h-[44px] bg-terminal-green/10 border border-terminal-green/30 rounded-lg hover:bg-terminal-green/20 hover:border-terminal-green/50 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-terminal-green/10"
        >
          <span className="flex items-center gap-1 text-xs font-semibold text-terminal-green">
            YES
            {flash === 'up' && <ArrowUp size={10} />}
            {flash === 'down' && <ArrowDown size={10} />}
          </span>
          <span className="text-sm font-mono font-bold text-terminal-green">
            {priceToPercent(market.yesAsk)}
          </span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); if (!isClosed) onSelect({ ...market, side: 'no' }) }}
          disabled={isClosed}
          className="flex items-center justify-between px-3 py-2 min-h-[44px] bg-terminal-red/10 border border-terminal-red/30 rounded-lg hover:bg-terminal-red/20 hover:border-terminal-red/50 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-terminal-red/10"
        >
          <span className="flex items-center gap-1 text-xs font-semibold text-terminal-red">
            NO
            {flash === 'up' && <ArrowDown size={10} />}
            {flash === 'down' && <ArrowUp size={10} />}
          </span>
          <span className="text-sm font-mono font-bold text-terminal-red">
            {priceToPercent(market.noAsk)}
          </span>
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-terminal-muted font-mono">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1" title="24h trading volume">
            <TrendingUp size={12} />
            {formatUsd(market.volume)}
          </span>
          <span className="flex items-center gap-1" title="Available liquidity in the order book">
            <DollarSign size={12} />
            {formatUsd(market.liquidity)}
          </span>
        </div>
        <span className={`flex items-center gap-1 ${urgencyColor}`} title="Market close time">
          <Clock size={12} />
          {closeLabel}
        </span>
      </div>
    </div>
  )
}
