import React, { useState, useEffect } from 'react'
import { ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react'
import { generateRecentTrades } from '../data/mockDetailData'
import Skeleton from './Skeleton'
import { normalizeTrade } from '../lib/normalize'

const DFLOW_BASE = '/api/dflow'

function formatTradeTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function RecentTrades({ market }) {
  const [trades, setTrades] = useState([])
  const [newTradeIdx, setNewTradeIdx] = useState(-1)

  // Initial load from DFlow /trades; fall back to simulated seed on failure
  useEffect(() => {
    let cancelled = false
    const ticker = market.ticker || market.id
    async function load() {
      try {
        const res = await fetch(`${DFLOW_BASE}/api/v1/trades?market_ticker=${encodeURIComponent(ticker)}&limit=20`)
        if (!res.ok) throw new Error(`Trades API: ${res.status}`)
        const data = await res.json()
        const raw = Array.isArray(data) ? data : (data.data || data.trades || [])
        if (!raw.length) throw new Error('Empty trades')
        const mapped = raw.map(normalizeTrade).filter(Boolean).slice(0, 20)
        if (!cancelled) setTrades(mapped)
      } catch {
        if (!cancelled) setTrades(generateRecentTrades(market.yesAsk, 20))
      }
    }
    load()
    return () => { cancelled = true }
  }, [market.id, market.ticker, market.yesAsk])

  // Simulate incoming trades on top of whatever seed we loaded
  useEffect(() => {
    const interval = setInterval(() => {
      setTrades(prev => {
        const lastPrice = prev[0]?.price || market.yesAsk
        const change = (Math.random() - 0.5) * 0.03
        const price = Math.max(0.01, Math.min(0.99, lastPrice + change))
        const side = Math.random() > 0.5 ? 'buy' : 'sell'
        const amount = Math.floor(50 + Math.random() * 3000)
        const newTrade = {
          id: `trade-live-${Date.now()}`,
          time: new Date().toISOString(),
          side,
          price: Math.round(price * 1000) / 1000,
          amount,
          total: Math.round(price * amount * 100) / 100,
        }
        setNewTradeIdx(0)
        setTimeout(() => setNewTradeIdx(-1), 600)
        return [newTrade, ...prev.slice(0, 19)]
      })
    }, 3000 + Math.random() * 5000)

    return () => clearInterval(interval)
  }, [market.yesAsk])

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Recent Trades
          </h3>
          <Zap size={10} className="text-terminal-yellow animate-pulse" />
        </div>
        <span className="text-[10px] font-mono text-terminal-muted">LIVE</span>
      </div>

      <div className="px-4 py-1.5">
        <div className="grid grid-cols-4 gap-2 text-[10px] text-terminal-muted uppercase tracking-wider">
          <span>Time</span>
          <span>Side</span>
          <span className="text-right">Price</span>
          <span className="text-right">Amount</span>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto divide-y divide-terminal-border/50">
        {trades.length === 0 && (
          <div className="divide-y divide-terminal-border/50">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 px-4 py-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-14 ml-auto" />
                <Skeleton className="h-3 w-14 ml-auto" />
              </div>
            ))}
          </div>
        )}
        {trades.map((trade, i) => (
          <div
            key={trade.id}
            className={`grid grid-cols-4 gap-2 px-4 py-1.5 text-xs font-mono transition-all duration-300 ${
              i === newTradeIdx ? 'bg-terminal-accent/10' : 'hover:bg-terminal-card/50'
            }`}
          >
            <span className="text-terminal-muted">{formatTradeTime(trade.time)}</span>
            <span className="flex items-center gap-1">
              {trade.side === 'buy' ? (
                <>
                  <ArrowUpRight size={10} className="text-terminal-green" />
                  <span className="text-terminal-green">BUY</span>
                </>
              ) : (
                <>
                  <ArrowDownRight size={10} className="text-terminal-red" />
                  <span className="text-terminal-red">SELL</span>
                </>
              )}
            </span>
            <span className={`text-right ${trade.side === 'buy' ? 'text-terminal-green' : 'text-terminal-red'}`}>
              {(trade.price * 100).toFixed(1)}¢
            </span>
            <span className="text-right text-terminal-text">${trade.amount.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
