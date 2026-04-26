import React from 'react'
import { Clock, TrendingUp, DollarSign, ArrowUp, ArrowDown, Lock, Zap } from 'lucide-react'
import { format } from 'date-fns'
import { formatMarketCloseFull } from '../lib/dateFormat'
import { formatUsd, priceToPercent, humanizeOutcomeLabel } from '../lib/format'
import { isMarketTradeable } from '../lib/normalize'
import { usePriceFlash } from '../hooks/useLivePrices'

function getUrgencyColor(closeTime) {
  if (!closeTime) return 'text-terminal-muted'
  const hours = (new Date(closeTime).getTime() - Date.now()) / 3600000
  if (!Number.isFinite(hours)) return 'text-terminal-muted'
  if (hours < 4) return 'text-terminal-red'
  if (hours < 24) return 'text-terminal-yellow'
  return 'text-terminal-muted'
}

export default function MarketCard({ market, onSelect }) {
  const closeLabel = market.closeTime ? format(new Date(market.closeTime), 'MMM d, yyyy') : '—'
  const closeTooltip = market.closeTime ? formatMarketCloseFull(market.closeTime) : 'Market close time'
  const urgencyColor = getUrgencyColor(market.closeTime)
  const yesPercent = (market.yesAsk * 100).toFixed(0)
  const noPercent = (market.noAsk * 100).toFixed(0)
  const closeMs = market.closeTime ? new Date(market.closeTime).getTime() : NaN
  const isClosed = Number.isFinite(closeMs) && closeMs <= Date.now()
  const tradeable = isMarketTradeable(market)
  const flash = usePriceFlash(market.id, market.yesAsk, market.noAsk)

  // Many DFlow events group sub-markets under the same `question` (e.g.
  // "Michael Rotten Tomatoes score?") with the differentiator in `yesSubTitle`
  // ("Above 85" / "Above 60" / ...). Promote that label so the cards aren't
  // visually identical. Falls back to the question for plain binary events.
  const rawOutcome = (market.yesSubTitle || market.subtitle || '').trim()
  const humanOutcome = humanizeOutcomeLabel(rawOutcome, `${market.question} ${market.eventTitle}`)
  const headline = humanOutcome && humanOutcome.toLowerCase() !== (market.question || '').toLowerCase()
    ? humanOutcome
    : market.question

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
            {headline}
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
          {tradeable ? (
            <span
              title="Open for trading"
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-terminal-green/10 border border-terminal-green/40 text-terminal-green"
            >
              <Zap size={9} className="fill-current" />
              Tradeable
            </span>
          ) : (
            <span
              title={isClosed ? 'Trading window has ended' : 'Not currently tradeable'}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-terminal-muted/10 border border-terminal-muted/40 text-terminal-muted"
            >
              <Lock size={9} />
              {isClosed ? 'Closed' : 'Not Tradeable'}
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
          onClick={(e) => { e.stopPropagation(); if (tradeable) onSelect({ ...market, side: 'yes' }) }}
          disabled={!tradeable}
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
          onClick={(e) => { e.stopPropagation(); if (tradeable) onSelect({ ...market, side: 'no' }) }}
          disabled={!tradeable}
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
        <span className={`flex items-center gap-1 ${urgencyColor}`} title={closeTooltip}>
          <Clock size={12} />
          {closeLabel}
        </span>
      </div>
    </div>
  )
}
