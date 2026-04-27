import React, { Suspense, lazy, useState } from 'react'
import { X, Clock, TrendingUp, DollarSign, Shield, Globe, ArrowLeft, Lock, Share2, Check } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { formatMarketCloseFull } from '../lib/dateFormat'
import { formatCompactNumber, humanizeOutcomeLabel, priceToPercent, priceToPercentFine } from '../lib/format'
import { useFocusTrap } from '../hooks/useFocusTrap'
import DepthChart from './DepthChart'
import OrderBook from './OrderBook'
import RecentTrades from './RecentTrades'
import TradePanel from './TradePanel'
import ActiveOrders from './ActiveOrders'
import { useConditionalOrders } from '../hooks/useConditionalOrders'

// Candlestick chart is the single largest dependency in the detail view.
const CandlestickChart = lazy(() => import('./CandlestickChart'))

const formatUsd = formatCompactNumber

export default function MarketDetail({ market, onClose }) {
  const { activeOrdersForMarket } = useConditionalOrders()
  const containerRef = useFocusTrap(!!market, onClose)
  const [copied, setCopied] = useState(false)
  if (!market) return null

  const orderLines = activeOrdersForMarket(market.id)

  const handleShare = async () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    try {
      if (navigator.share) {
        await navigator.share({ title: market.question, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // User dismissed share sheet, or clipboard blocked — silent.
    }
  }
  const closeMs = market.closeTime ? new Date(market.closeTime).getTime() : NaN
  const hasClose = Number.isFinite(closeMs)
  const timeLeft = hasClose ? formatDistanceToNow(closeMs, { addSuffix: true }) : '—'
  const closeDate = formatMarketCloseFull(market.closeTime)
  const hoursLeft = hasClose ? (closeMs - Date.now()) / 3600000 : Infinity
  const isClosed = hasClose && hoursLeft <= 0

  const rawOutcome = (market.yesSubTitle || market.subtitle || '').trim()
  const humanOutcome = humanizeOutcomeLabel(rawOutcome, `${market.question} ${market.eventTitle}`)
  const headline = humanOutcome && humanOutcome.toLowerCase() !== (market.question || '').toLowerCase()
    ? humanOutcome
    : market.question
  const urgencyColor = !hasClose
    ? 'text-terminal-muted'
    : hoursLeft < 4 ? 'text-terminal-red' : hoursLeft < 24 ? 'text-terminal-yellow' : 'text-terminal-muted'

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={containerRef}
        className="relative ml-auto w-full max-w-[1400px] bg-terminal-bg overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-terminal-surface border-b border-terminal-border">
          <div className="px-4 md:px-6 py-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <button
                onClick={onClose}
                className="flex items-center gap-1.5 text-xs text-terminal-muted hover:text-terminal-text transition-colors mb-2"
              >
                <ArrowLeft size={12} />
                Back to Markets
              </button>
              <h2 className="text-lg font-semibold text-white leading-tight">{market.eventTitle}</h2>
              {headline && headline.toLowerCase() !== (market.eventTitle || '').toLowerCase() && (
                <p className="text-sm text-terminal-muted mt-1">{headline}</p>
              )}
              <div className="flex items-center gap-4 mt-3 flex-wrap">
                {isClosed && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-muted/10 border border-terminal-muted/40 text-terminal-muted">
                    <Lock size={10} />
                    Trading Closed
                  </span>
                )}
                <span className={`flex items-center gap-1 text-xs ${urgencyColor}`}>
                  <Clock size={12} />
                  {timeLeft}
                </span>
                <span className="flex items-center gap-1 text-xs text-terminal-muted">
                  <TrendingUp size={12} />
                  Vol: {formatUsd(market.volume)}
                </span>
                <span className="flex items-center gap-1 text-xs text-terminal-muted">
                  <DollarSign size={12} />
                  Liq: {formatUsd(market.liquidity)}
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-card border border-terminal-border ${
                  market.category === 'Sports' ? 'text-terminal-green' :
                  market.category === 'Crypto' ? 'text-terminal-yellow' :
                  market.category === 'Politics' ? 'text-terminal-cyan' :
                  'text-terminal-red'
                }`}>
                  {market.category}
                </span>
                {market.subcategory && (
                  <span className="text-[10px] text-terminal-muted font-mono">
                    {market.subcategory}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={handleShare}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all"
                title="Copy shareable link"
                aria-label="Share market link"
              >
                {copied ? <Check size={14} className="text-terminal-green" /> : <Share2 size={14} />}
                <span className="hidden sm:inline">{copied ? 'Copied' : 'Share'}</span>
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Price bar */}
          <div className="px-4 md:px-6 pb-3 flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-mono font-bold text-terminal-green">
                {priceToPercent(market.yesAsk)}
              </span>
              <span className="text-xs text-terminal-muted">YES</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-mono font-bold text-terminal-red">
                {priceToPercent(market.noAsk)}
              </span>
              <span className="text-xs text-terminal-muted">NO</span>
            </div>
            <div className="flex-1 h-2 bg-terminal-card rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-terminal-green to-emerald-400 rounded-full transition-all"
                style={{ width: `${Number.isFinite(market.yesAsk) ? (market.yesAsk * 100).toFixed(0) : 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* Main content — 70/30 split */}
        <div className="p-4 md:p-6">
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Left column — 70% */}
            <div className="lg:w-[70%] space-y-6">
              <Suspense fallback={
                <div className="bg-terminal-surface border border-terminal-border rounded-lg h-80 flex items-center justify-center text-sm text-terminal-muted">
                  Loading chart…
                </div>
              }>
                <CandlestickChart market={market} orderLines={orderLines} />
              </Suspense>
              <ActiveOrders marketId={market.id} marketTicker={market.ticker} />
              <DepthChart market={market} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <OrderBook market={market} />
                <RecentTrades market={market} />
              </div>
            </div>

            {/* Right column — 30% */}
            <div className="lg:w-[30%] space-y-6">
              <TradePanel market={market} />

              {/* Market Info */}
              <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
                <h4 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-3">
                  Market Info
                </h4>
                <div className="space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Market ID</span>
                    <span className="font-mono text-terminal-text">{market.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Close Time</span>
                    <span className="font-mono text-terminal-text">{closeDate}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">YES Ask / Bid</span>
                    <span className="font-mono">
                      <span className="text-terminal-green">{priceToPercentFine(market.yesAsk)}</span>
                      {' / '}
                      <span className="text-terminal-green/70">{priceToPercentFine(market.yesBid)}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">NO Ask / Bid</span>
                    <span className="font-mono">
                      <span className="text-terminal-red">{priceToPercentFine(market.noAsk)}</span>
                      {' / '}
                      <span className="text-terminal-red/70">{priceToPercentFine(market.noBid)}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Spread</span>
                    <span className="font-mono text-terminal-text">
                      {Number.isFinite(market.yesAsk) && Number.isFinite(market.yesBid)
                        ? `${((market.yesAsk - market.yesBid) * 100).toFixed(1)}¢`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Total Volume</span>
                    <span className="font-mono text-terminal-text">{formatUsd(market.volume)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Liquidity</span>
                    <span className="font-mono text-terminal-text">{formatUsd(market.liquidity)}</span>
                  </div>
                  <div className="h-px bg-terminal-border my-1" />
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Protocol</span>
                    <span className="font-mono text-terminal-accent">DFlow</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Chain</span>
                    <span className="font-mono text-terminal-text flex items-center gap-1">
                      <Globe size={10} /> Solana
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-terminal-muted">Settlement</span>
                    <span className="font-mono text-terminal-text flex items-center gap-1">
                      <Shield size={10} /> Oracle
                    </span>
                  </div>
                </div>
              </div>

              {/* Settlement rules */}
              <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
                <h4 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-3">
                  Settlement Rules
                </h4>
                <div className="space-y-2 text-xs text-terminal-muted leading-relaxed">
                  <p>
                    This market resolves to <span className="text-terminal-green font-semibold">YES ($1.00)</span> if
                    the stated condition is true at the close time, or <span className="text-terminal-red font-semibold">NO ($0.00)</span> otherwise.
                  </p>
                  <p>
                    Resolution is determined by the designated oracle source.
                    Settlement occurs within 24 hours of market close.
                  </p>
                  <p className="text-[10px] text-terminal-muted/60">
                    Dispute window: 48 hours post-settlement.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
