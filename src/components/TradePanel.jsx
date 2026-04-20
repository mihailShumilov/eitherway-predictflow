import React, { useState, useCallback, useMemo } from 'react'
import {
  ArrowUpCircle, ArrowDownCircle, AlertCircle, Check, Loader2,
  Eye, ShoppingCart, Target, TrendingDown, TrendingUp, Zap, Repeat, StopCircle,
  Lock, Info, Wallet
} from 'lucide-react'
import { useWallet } from '../hooks/useWallet'
import { useConditionalOrders } from '../hooks/useConditionalOrders'
import { useDCA, DCA_FREQUENCIES } from '../hooks/useDCA'
import { useUsdcBalance } from '../hooks/useUsdcBalance'

const DFLOW_QUOTE_URL = 'https://dev-quote-api.dflow.net/quote'
const DFLOW_ORDER_URL = 'https://dev-quote-api.dflow.net/order'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function getTokenMint(market, side) {
  if (side === 'yes' && market.yesMint) return market.yesMint
  if (side === 'no' && market.noMint) return market.noMint
  return side === 'yes' ? `YES-${market.id}-mint` : `NO-${market.id}-mint`
}

const ORDER_TABS = [
  { key: 'market', label: 'Market', icon: Zap },
  { key: 'limit', label: 'Limit', icon: Target },
  { key: 'stop-loss', label: 'Stop-Loss', icon: TrendingDown },
  { key: 'take-profit', label: 'Take-Profit', icon: TrendingUp },
  { key: 'dca', label: 'DCA', icon: Repeat },
]

function formatDcaTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function shortSig(sig) {
  if (!sig || sig === 'signed' || sig === 'simulated') return sig || '—'
  return `${sig.slice(0, 6)}…${sig.slice(-4)}`
}

function DcaProgress({ strategy, onStop, compact = false }) {
  const completed = strategy.executions.length
  const total = strategy.totalPurchases
  const spent = strategy.executions.reduce((s, e) => s + e.amount, 0)
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0
  const isActive = strategy.status === 'active'
  const nextRun = strategy.nextRunAt ? new Date(strategy.nextRunAt) : null
  const now = Date.now()
  const nextLabel = nextRun
    ? (nextRun.getTime() <= now ? 'firing now…' : `in ${Math.max(1, Math.round((nextRun.getTime() - now) / 60000))} min`)
    : null

  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Repeat size={12} className={isActive ? 'text-terminal-accent' : 'text-terminal-muted'} />
          <span className="text-xs font-semibold text-terminal-text uppercase tracking-wider">
            {isActive ? 'DCA Active' : strategy.status === 'completed' ? 'DCA Completed' : 'DCA Cancelled'}
          </span>
          <span className={`text-[10px] font-bold uppercase ${strategy.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {strategy.side}
          </span>
        </div>
        {isActive && onStop && (
          <button
            onClick={onStop}
            className="flex items-center gap-1 text-[10px] text-terminal-red/80 hover:text-terminal-red transition-colors"
          >
            <StopCircle size={12} />
            Stop DCA
          </button>
        )}
      </div>

      <div className="text-xs text-terminal-text font-mono">
        {completed} of {total} purchases completed (${spent.toFixed(2)} / ${strategy.totalBudget.toFixed(2)})
      </div>

      <div className="h-1.5 bg-terminal-surface rounded-full overflow-hidden">
        <div
          className={`h-full ${strategy.status === 'cancelled' ? 'bg-terminal-muted' : 'bg-terminal-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-terminal-muted font-mono">
        <span>
          ${strategy.amountPerBuy.toFixed(2)} · every {DCA_FREQUENCIES.find(f => f.key === strategy.frequency)?.label}
        </span>
        {isActive && nextLabel && <span>Next: {nextLabel}</span>}
      </div>

      {!compact && strategy.executions.length > 0 && (
        <div className="pt-2 border-t border-terminal-border/50">
          <p className="text-[10px] text-terminal-muted uppercase tracking-wider mb-1">History</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {strategy.executions.slice().reverse().map(e => (
              <div key={e.id} className="flex items-center justify-between text-[10px] font-mono text-terminal-muted gap-2">
                <span>{formatDcaTime(e.timestamp)}</span>
                <span className="text-terminal-text">${e.amount.toFixed(2)}</span>
                <span>@{(e.price * 100).toFixed(1)}¢</span>
                <span className={e.txSigned ? 'text-terminal-green' : 'text-terminal-yellow'} title={e.txSignature}>
                  {e.txSigned ? shortSig(e.txSignature) : 'sim'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function hasPosition(marketId) {
  try {
    const positions = JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
    return positions.some(p => p.marketId === marketId && p.status === 'filled')
  } catch {
    return false
  }
}

export default function TradePanel({ market }) {
  const { connected, connect, address } = useWallet()
  const { addOrder } = useConditionalOrders()
  const { strategiesForMarket, startStrategy, stopStrategy } = useDCA()
  const { balance: usdcBalance, loading: usdcLoading } = useUsdcBalance(address)
  const [side, setSide] = useState(market?.side || 'yes')
  const [orderType, setOrderType] = useState('market')
  const [amount, setAmount] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [quote, setQuote] = useState(null)
  const [result, setResult] = useState(null)
  const [dcaPerBuy, setDcaPerBuy] = useState('')
  const [dcaFrequency, setDcaFrequency] = useState('4h')
  const [dcaBudget, setDcaBudget] = useState('')

  const dcaStrategies = strategiesForMarket(market.id)
  const activeDca = dcaStrategies.find(s => s.status === 'active')

  const isClosed = new Date(market.closeTime).getTime() <= Date.now()
  const hasPos = useMemo(() => hasPosition(market.id), [market.id])
  const price = side === 'yes' ? market.yesAsk : market.noAsk
  const amountNum = parseFloat(amount) || 0
  const insufficientUsdc = connected && usdcBalance != null && amountNum > 0 && amountNum > usdcBalance
  const insufficientDcaBudget = connected && usdcBalance != null && (parseFloat(dcaBudget) || 0) > 0 && (parseFloat(dcaBudget) || 0) > usdcBalance
  const shares = amount ? (parseFloat(amount) / price).toFixed(2) : '0'
  const potentialPayout = amount ? (parseFloat(amount) / price).toFixed(2) : '0'
  const profit = amount ? ((parseFloat(amount) / price) - parseFloat(amount)).toFixed(2) : '0'

  const visibleTabs = ORDER_TABS.filter(t => {
    if (t.key === 'stop-loss' || t.key === 'take-profit') return hasPos
    return true
  })

  const effectiveOrderType = visibleTabs.find(t => t.key === orderType) ? orderType : 'market'

  const handlePreview = useCallback(async () => {
    if (!amount || parseFloat(amount) <= 0) return
    setPreviewing(true)
    setQuote(null)

    try {
      const outputMint = getTokenMint(market, side)
      const amountLamports = Math.floor(parseFloat(amount) * 1e6)
      const url = `${DFLOW_QUOTE_URL}?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${amountLamports}`
      const res = await fetch(url)

      if (res.ok) {
        const data = await res.json()
        setQuote({
          outputAmount: data.outAmount ? (data.outAmount / 1e6).toFixed(4) : shares,
          priceImpact: data.priceImpact || '0.12',
          fee: data.fee || (parseFloat(amount) * 0.001).toFixed(4),
          route: data.routePlan?.length || 1,
          source: 'DFlow',
        })
      } else {
        throw new Error('Quote API unavailable')
      }
    } catch {
      const slippage = Math.random() * 0.5 + 0.05
      const fee = (parseFloat(amount) * 0.001).toFixed(4)
      setQuote({
        outputAmount: shares,
        priceImpact: slippage.toFixed(2),
        fee,
        route: 1,
        source: 'Simulated',
      })
    } finally {
      setPreviewing(false)
    }
  }, [amount, side, market, shares])

  const handleMarketTrade = useCallback(async () => {
    if (!connected) { connect(); return }
    if (!amount || parseFloat(amount) <= 0) return

    setSubmitting(true)
    setResult(null)

    try {
      const outputMint = getTokenMint(market, side)
      const amountLamports = Math.floor(parseFloat(amount) * 1e6)

      let txSigned = false
      try {
        const url = `${DFLOW_ORDER_URL}?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${amountLamports}&userPublicKey=${address}`
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          const provider = window.solflare?.isSolflare ? window.solflare : window.solana
          if (provider && data.transaction) {
            const tx = typeof data.transaction === 'string'
              ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
              : data.transaction
            await provider.signTransaction(tx)
            txSigned = true
          }
        }
      } catch {
        // DFlow order API not available, simulate
      }

      await new Promise(r => setTimeout(r, txSigned ? 500 : 1500))

      const order = {
        id: `ord-${Date.now()}`,
        marketId: market.id,
        side,
        type: 'market',
        amount: parseFloat(amount),
        price,
        shares: parseFloat(shares),
        timestamp: new Date().toISOString(),
        status: 'filled',
        txSigned,
      }

      const positions = JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
      positions.push({
        ...order,
        question: market.question,
        eventTitle: market.eventTitle,
        category: market.category,
      })
      localStorage.setItem('predictflow_positions', JSON.stringify(positions))

      setResult({ success: true, order })
      setQuote(null)
      setAmount('')
    } catch (err) {
      setResult({ success: false, error: err.message || 'Order failed' })
    } finally {
      setSubmitting(false)
    }
  }, [connected, connect, amount, side, price, shares, market, address])

  const handleConditionalOrder = useCallback(() => {
    if (!connected) { connect(); return }
    if (!amount || parseFloat(amount) <= 0) return
    if (!triggerPrice || parseFloat(triggerPrice) <= 0 || parseFloat(triggerPrice) >= 100) return

    const tp = parseFloat(triggerPrice) / 100

    if (effectiveOrderType === 'stop-loss' && tp >= price) {
      setResult({ success: false, error: 'Stop-loss trigger must be below current price' })
      return
    }
    if (effectiveOrderType === 'take-profit' && tp <= price) {
      setResult({ success: false, error: 'Take-profit target must be above current price' })
      return
    }

    const newOrder = addOrder({
      orderType: effectiveOrderType,
      marketId: market.id,
      marketTicker: market.ticker,
      eventTicker: market.eventTicker,
      yesMint: market.yesMint,
      noMint: market.noMint,
      question: market.question,
      eventTitle: market.eventTitle,
      category: market.category,
      side,
      amount: parseFloat(amount),
      triggerPrice: tp,
      currentPrice: price,
    })

    setResult({ success: true, conditional: true, order: newOrder })
    setAmount('')
    setTriggerPrice('')
  }, [connected, connect, amount, triggerPrice, effectiveOrderType, side, price, market, addOrder])

  const dcaPerBuyNum = parseFloat(dcaPerBuy) || 0
  const dcaBudgetNum = parseFloat(dcaBudget) || 0
  const dcaPurchases = dcaPerBuyNum > 0 ? Math.floor(dcaBudgetNum / dcaPerBuyNum) : 0
  const dcaFreqLabel = DCA_FREQUENCIES.find(f => f.key === dcaFrequency)?.label || dcaFrequency

  const handleStartDca = useCallback(() => {
    if (!connected) { connect(); return }
    if (dcaPerBuyNum <= 0 || dcaBudgetNum <= 0 || dcaPurchases <= 0) {
      setResult({ success: false, error: 'Enter valid amount and budget' })
      return
    }
    const strategy = startStrategy({
      marketId: market.id,
      marketTicker: market.ticker,
      eventTicker: market.eventTicker,
      yesMint: market.yesMint,
      noMint: market.noMint,
      question: market.question,
      eventTitle: market.eventTitle,
      category: market.category,
      side,
      amountPerBuy: dcaPerBuyNum,
      frequency: dcaFrequency,
      totalBudget: dcaBudgetNum,
      referencePrice: price,
    })
    setResult({ success: true, dca: true, strategy })
    setDcaPerBuy('')
    setDcaBudget('')
  }, [connected, connect, dcaPerBuyNum, dcaBudgetNum, dcaPurchases, startStrategy, market, side, dcaFrequency, price])

  const handleSubmit = effectiveOrderType === 'market'
    ? handleMarketTrade
    : effectiveOrderType === 'dca'
      ? handleStartDca
      : handleConditionalOrder

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Trade
        </h3>
        {isClosed && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-muted/10 border border-terminal-muted/40 text-terminal-muted">
            <Lock size={10} />
            Trading Closed
          </span>
        )}
        {!isClosed && !connected && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-yellow/10 border border-terminal-yellow/30 text-terminal-yellow">
            <Wallet size={10} />
            Wallet Required
          </span>
        )}
      </div>

      <div className="p-4 space-y-4">
        {isClosed && (
          <div className="flex items-start gap-2 bg-terminal-muted/10 border border-terminal-muted/30 rounded-lg p-3 text-xs text-terminal-muted">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-terminal-text">Market closed</p>
              <p className="mt-0.5">This market is past its close time. Trading is disabled pending settlement.</p>
            </div>
          </div>
        )}

        {connected && usdcBalance != null && (
          <div className="flex items-center justify-between text-[11px] text-terminal-muted font-mono">
            <span className="flex items-center gap-1" title="Your USDC balance on Solana">
              <Wallet size={10} />
              USDC Balance
            </span>
            <span className="text-terminal-text">${usdcBalance.toFixed(2)}</span>
          </div>
        )}

        {/* Side selector */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => { setSide('yes'); setQuote(null); setResult(null) }}
            disabled={isClosed}
            className={`flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${
              side === 'yes'
                ? 'bg-terminal-green text-white shadow-lg shadow-terminal-green/20'
                : 'bg-terminal-green/10 text-terminal-green border border-terminal-green/30 hover:bg-terminal-green/20'
            }`}
          >
            <ArrowUpCircle size={16} />
            BUY YES
          </button>
          <button
            onClick={() => { setSide('no'); setQuote(null); setResult(null) }}
            disabled={isClosed}
            className={`flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${
              side === 'no'
                ? 'bg-terminal-red text-white shadow-lg shadow-terminal-red/20'
                : 'bg-terminal-red/10 text-terminal-red border border-terminal-red/30 hover:bg-terminal-red/20'
            }`}
          >
            <ArrowDownCircle size={16} />
            BUY NO
          </button>
        </div>

        {/* Order type tabs */}
        <div className="flex bg-terminal-card border border-terminal-border rounded-lg overflow-hidden">
          {visibleTabs.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => { setOrderType(tab.key); setResult(null); setQuote(null) }}
                className={`flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-medium uppercase tracking-wider transition-all ${
                  effectiveOrderType === tab.key
                    ? 'bg-terminal-highlight text-terminal-accent'
                    : 'text-terminal-muted hover:text-terminal-text'
                }`}
              >
                <Icon size={10} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Trigger price — for conditional orders */}
        {effectiveOrderType !== 'market' && effectiveOrderType !== 'dca' && (
          <div>
            <label className="text-xs text-terminal-muted mb-1 flex items-center justify-between">
              <span>
                {effectiveOrderType === 'limit' ? 'Limit Price' :
                 effectiveOrderType === 'stop-loss' ? 'Stop Trigger Price' :
                 'Take-Profit Target'}
                {' '}(¢)
              </span>
              <span className="text-[10px] font-mono text-terminal-muted">
                Current: {(price * 100).toFixed(1)}¢
              </span>
            </label>

            <input
              type="range"
              min="1"
              max="99"
              step="1"
              value={triggerPrice || Math.round(price * 100)}
              onChange={(e) => setTriggerPrice(e.target.value)}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer mb-2"
              style={{
                background: `linear-gradient(to right, #10b981 0%, #3b82f6 ${triggerPrice || Math.round(price * 100)}%, #1e2740 ${triggerPrice || Math.round(price * 100)}%)`,
              }}
            />

            <div className="relative">
              <input
                type="number"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder={`${(price * 100).toFixed(0)}`}
                min="1"
                max="99"
                step="1"
                className="w-full px-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-terminal-muted text-xs">¢</span>
            </div>

            {effectiveOrderType === 'stop-loss' && triggerPrice && parseFloat(triggerPrice) >= price * 100 && (
              <p className="text-[10px] text-terminal-red mt-1">Must be below current price ({(price * 100).toFixed(1)}¢)</p>
            )}
            {effectiveOrderType === 'take-profit' && triggerPrice && parseFloat(triggerPrice) <= price * 100 && (
              <p className="text-[10px] text-terminal-red mt-1">Must be above current price ({(price * 100).toFixed(1)}¢)</p>
            )}
          </div>
        )}

        {effectiveOrderType !== 'dca' && (
        <>
        {/* Amount */}
        <div>
          <label className="text-xs text-terminal-muted mb-1 block">Amount (USDC)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setQuote(null); setResult(null) }}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
            />
          </div>
          <div className="flex gap-2 mt-2">
            {[10, 25, 50, 100].map(preset => (
              <button
                key={preset}
                onClick={() => { setAmount(preset.toString()); setQuote(null); setResult(null) }}
                className="flex-1 py-1 text-xs font-mono bg-terminal-card border border-terminal-border rounded hover:border-terminal-accent/50 text-terminal-muted hover:text-terminal-text transition-all"
              >
                ${preset}
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        {amount && parseFloat(amount) > 0 && (
          <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted flex items-center gap-1" title={effectiveOrderType === 'market' ? 'Market price your order will fill at' : 'Price that will trigger this conditional order'}>
                {effectiveOrderType === 'market' ? 'Price' : 'Trigger Price'}
                <Info size={10} className="text-terminal-muted/60" />
              </span>
              <span className="font-mono text-terminal-text">
                {effectiveOrderType === 'market'
                  ? `${(price * 100).toFixed(1)}¢`
                  : triggerPrice ? `${parseFloat(triggerPrice).toFixed(1)}¢` : '—'
                }
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted flex items-center gap-1" title="Shares you'll receive — each pays $1.00 if the market resolves in your favor">
                Est. Shares
                <Info size={10} className="text-terminal-muted/60" />
              </span>
              <span className="font-mono text-terminal-text">
                {effectiveOrderType !== 'market' && triggerPrice
                  ? (parseFloat(amount) / (parseFloat(triggerPrice) / 100)).toFixed(2)
                  : shares
                }
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted flex items-center gap-1" title="Maximum USDC you'll receive if the market resolves in your favor">
                Potential Payout
                <Info size={10} className="text-terminal-muted/60" />
              </span>
              <span className="font-mono text-terminal-green">${potentialPayout}</span>
            </div>
            {effectiveOrderType !== 'market' && (
              <div className="flex justify-between text-xs border-t border-terminal-border pt-2">
                <span className="text-terminal-muted">Order Type</span>
                <span className={`font-mono font-semibold ${
                  effectiveOrderType === 'limit' ? 'text-terminal-accent' :
                  effectiveOrderType === 'stop-loss' ? 'text-terminal-red' :
                  'text-terminal-green'
                }`}>
                  {effectiveOrderType === 'limit' ? 'Limit' :
                   effectiveOrderType === 'stop-loss' ? 'Stop-Loss' :
                   'Take-Profit'}
                </span>
              </div>
            )}
            {effectiveOrderType === 'market' && (
              <div className="flex justify-between text-xs border-t border-terminal-border pt-2">
                <span className="text-terminal-muted">Potential Profit</span>
                <span className={`font-mono font-bold ${parseFloat(profit) > 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {parseFloat(profit) > 0 ? '+' : ''}${profit}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Quote result — market orders only */}
        {quote && effectiveOrderType === 'market' && (
          <div className="bg-terminal-accent/5 border border-terminal-accent/20 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-terminal-accent font-semibold">Quote Preview</span>
              <span className="text-[10px] text-terminal-muted font-mono">{quote.source}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted">Output</span>
              <span className="font-mono text-terminal-text">{quote.outputAmount} shares</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted flex items-center gap-1" title="How much your trade moves the market price. Lower is better.">
                Price Impact
                <Info size={10} className="text-terminal-muted/60" />
              </span>
              <span className={`font-mono ${parseFloat(quote.priceImpact) > 1 ? 'text-terminal-yellow' : 'text-terminal-green'}`}>
                {quote.priceImpact}%
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-terminal-muted flex items-center gap-1" title="Protocol fee for this trade">
                Fee
                <Info size={10} className="text-terminal-muted/60" />
              </span>
              <span className="font-mono text-terminal-text">${quote.fee}</span>
            </div>
          </div>
        )}

        {/* Insufficient balance warning */}
        {insufficientUsdc && (
          <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-2.5 text-xs text-terminal-yellow">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Insufficient USDC</p>
              <p className="text-terminal-yellow/80 mt-0.5 font-mono">
                You have ${usdcBalance?.toFixed(2)}, need ${amountNum.toFixed(2)}.
              </p>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="space-y-2">
          {effectiveOrderType === 'market' && amount && parseFloat(amount) > 0 && !quote && connected && (
            <button
              onClick={handlePreview}
              disabled={previewing}
              className="w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 bg-terminal-card border border-terminal-border text-terminal-text hover:border-terminal-accent hover:text-terminal-accent disabled:opacity-50"
            >
              {previewing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Fetching Quote...
                </>
              ) : (
                <>
                  <Eye size={14} />
                  Preview Order
                </>
              )}
            </button>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting || isClosed || (!amount && connected) || insufficientUsdc}
            className={`w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 active:scale-[0.99] ${
              effectiveOrderType === 'market'
                ? side === 'yes'
                  ? 'bg-terminal-green hover:bg-emerald-500 text-white shadow-lg shadow-terminal-green/20'
                  : 'bg-terminal-red hover:bg-red-500 text-white shadow-lg shadow-terminal-red/20'
                : effectiveOrderType === 'limit'
                  ? 'bg-terminal-accent hover:bg-blue-500 text-white shadow-lg shadow-terminal-accent/20'
                  : effectiveOrderType === 'stop-loss'
                    ? 'bg-terminal-red hover:bg-red-500 text-white shadow-lg shadow-terminal-red/20'
                    : 'bg-terminal-green hover:bg-emerald-500 text-white shadow-lg shadow-terminal-green/20'
            } disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100`}
          >
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {connected ? 'Signing & Submitting...' : 'Placing Order...'}
              </>
            ) : isClosed ? (
              <>
                <Lock size={14} />
                Trading Closed
              </>
            ) : !connected ? (
              <>
                <Wallet size={14} />
                Connect Wallet to Trade
              </>
            ) : insufficientUsdc ? (
              <>
                <AlertCircle size={14} />
                Insufficient USDC
              </>
            ) : effectiveOrderType === 'market' ? (
              <>
                <ShoppingCart size={14} />
                {`Buy ${side.toUpperCase()} — ${amount ? `$${amount}` : 'Enter Amount'}`}
              </>
            ) : (
              <>
                {effectiveOrderType === 'limit' && <Target size={14} />}
                {effectiveOrderType === 'stop-loss' && <TrendingDown size={14} />}
                {effectiveOrderType === 'take-profit' && <TrendingUp size={14} />}
                {`Place ${effectiveOrderType === 'limit' ? 'Limit' : effectiveOrderType === 'stop-loss' ? 'Stop-Loss' : 'Take-Profit'} Order`}
              </>
            )}
          </button>
        </div>
        </>
        )}

        {/* DCA form / progress */}
        {effectiveOrderType === 'dca' && (
          <div className="space-y-3">
            {!activeDca && (
              <>
                <div>
                  <label className="text-xs text-terminal-muted mb-1 block">Amount per Purchase (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
                    <input
                      type="number"
                      value={dcaPerBuy}
                      onChange={(e) => { setDcaPerBuy(e.target.value); setResult(null) }}
                      placeholder="50.00"
                      min="0"
                      step="0.01"
                      className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-terminal-muted mb-1 block">Frequency</label>
                  <select
                    value={dcaFrequency}
                    onChange={(e) => setDcaFrequency(e.target.value)}
                    className="w-full px-3 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
                  >
                    {DCA_FREQUENCIES.map(f => (
                      <option key={f.key} value={f.key}>Every {f.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-terminal-muted mb-1 block">Total Budget (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
                    <input
                      type="number"
                      value={dcaBudget}
                      onChange={(e) => { setDcaBudget(e.target.value); setResult(null) }}
                      placeholder="500.00"
                      min="0"
                      step="0.01"
                      className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
                    />
                  </div>
                </div>

                {dcaPerBuyNum > 0 && dcaBudgetNum > 0 && (
                  <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 text-xs text-terminal-text leading-relaxed">
                    Will buy <span className="font-mono font-semibold">${dcaPerBuyNum.toFixed(2)}</span>{' '}
                    of <span className={`font-semibold ${side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {side.toUpperCase()}
                    </span>{' '}
                    every {dcaFreqLabel}.<br />
                    Total budget: <span className="font-mono font-semibold">${dcaBudgetNum.toFixed(2)}</span>.
                    Approximately <span className="font-mono font-semibold">{dcaPurchases}</span> purchases.
                  </div>
                )}

                {insufficientDcaBudget && (
                  <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-2.5 text-xs text-terminal-yellow">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">Budget exceeds balance</p>
                      <p className="text-terminal-yellow/80 mt-0.5 font-mono">
                        You have ${usdcBalance?.toFixed(2)}, DCA budget is ${dcaBudgetNum.toFixed(2)}.
                      </p>
                    </div>
                  </div>
                )}

                <button
                  onClick={handleStartDca}
                  disabled={isClosed || !dcaPerBuyNum || !dcaBudgetNum || dcaPurchases < 1 || insufficientDcaBudget}
                  className="w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-terminal-accent hover:bg-blue-500 text-white shadow-lg shadow-terminal-accent/20 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  {isClosed ? (
                    <>
                      <Lock size={14} />
                      Trading Closed
                    </>
                  ) : insufficientDcaBudget ? (
                    <>
                      <AlertCircle size={14} />
                      Insufficient USDC
                    </>
                  ) : (
                    <>
                      <Repeat size={14} />
                      {connected ? 'Start DCA' : 'Connect Wallet to Start DCA'}
                    </>
                  )}
                </button>
              </>
            )}

            {activeDca && (
              <DcaProgress strategy={activeDca} onStop={() => stopStrategy(activeDca.id)} />
            )}

            {dcaStrategies.filter(s => s.status !== 'active').length > 0 && !activeDca && (
              <div className="space-y-2">
                <p className="text-[10px] text-terminal-muted uppercase tracking-wider">Past strategies</p>
                {dcaStrategies.filter(s => s.status !== 'active').slice(-3).map(s => (
                  <DcaProgress key={s.id} strategy={s} compact />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
            result.success
              ? 'bg-terminal-green/10 border border-terminal-green/30 text-terminal-green'
              : 'bg-terminal-red/10 border border-terminal-red/30 text-terminal-red'
          }`}>
            {result.success ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
            <div>
              <p className="font-medium">
                {result.success
                  ? result.dca
                    ? 'DCA Strategy Started!'
                    : result.conditional
                      ? 'Conditional Order Placed!'
                      : 'Order Filled!'
                  : 'Order Failed'
                }
              </p>
              {result.success && result.dca && (
                <p className="text-terminal-muted mt-0.5">
                  Buying ${result.strategy.amountPerBuy.toFixed(2)} of {result.strategy.side.toUpperCase()} every{' '}
                  {DCA_FREQUENCIES.find(f => f.key === result.strategy.frequency)?.label}.
                </p>
              )}
              {result.success && result.conditional && (
                <p className="text-terminal-muted mt-0.5">
                  {result.order.orderType} order set at {(result.order.triggerPrice * 100).toFixed(1)}¢ for ${result.order.amount.toFixed(2)}
                </p>
              )}
              {result.success && !result.conditional && !result.dca && result.order && (
                <p className="text-terminal-muted mt-0.5">
                  {result.order.shares} shares @ {(result.order.price * 100).toFixed(1)}¢ = ${result.order.amount.toFixed(2)}
                  {result.order.txSigned && ' (tx signed)'}
                </p>
              )}
              {!result.success && result.error && (
                <p className="text-terminal-muted mt-0.5">{result.error}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
