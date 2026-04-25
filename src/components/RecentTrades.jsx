import React, { useState, useEffect, useRef } from 'react'
import { ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react'
import { generateRecentTrades } from '../data/mockDetailData'
import Skeleton from './Skeleton'
import { normalizeTrade } from '../lib/normalize'
import { DFLOW_PROXY_BASE, SOLANA_NETWORK } from '../config/env'

const DFLOW_BASE = DFLOW_PROXY_BASE
const ALLOW_MOCK_FALLBACK = (SOLANA_NETWORK || '').toLowerCase() !== 'mainnet'
const POLL_MS = 8000
const TRADE_LIMIT = 20

function formatTradeTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function RecentTrades({ market }) {
  const [trades, setTrades] = useState([])
  const [newTradeIds, setNewTradeIds] = useState(() => new Set())
  const seenIdsRef = useRef(new Set())

  // Poll the per-market /trades endpoint. DFlow filters by `ticker=`; the
  // earlier `market_ticker=` parameter was silently ignored which caused every
  // market to render the same global firehose. Fall back to the synthetic seed
  // only on devnet/dev — mainnet must show real activity or nothing.
  useEffect(() => {
    let cancelled = false
    const ticker = market.ticker || market.id
    if (!ticker) return
    seenIdsRef.current = new Set()

    async function load(isFirst) {
      try {
        const url = `${DFLOW_BASE}/api/v1/trades?ticker=${encodeURIComponent(ticker)}&limit=${TRADE_LIMIT}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Trades API: ${res.status}`)
        const data = await res.json()
        const raw = Array.isArray(data) ? data : (data.data || data.trades || [])
        const mapped = raw.map(normalizeTrade).filter(Boolean).slice(0, TRADE_LIMIT)
        if (cancelled) return
        if (mapped.length === 0) {
          if (isFirst && ALLOW_MOCK_FALLBACK) setTrades(generateRecentTrades(market.yesAsk, TRADE_LIMIT))
          else setTrades([])
          return
        }
        const seen = seenIdsRef.current
        const fresh = mapped.filter(t => !seen.has(t.id)).map(t => t.id)
        for (const id of fresh) seen.add(id)
        if (fresh.length && !isFirst) {
          setNewTradeIds(new Set(fresh))
          setTimeout(() => setNewTradeIds(new Set()), 600)
        }
        setTrades(mapped)
      } catch {
        if (cancelled) return
        if (isFirst && ALLOW_MOCK_FALLBACK) setTrades(generateRecentTrades(market.yesAsk, TRADE_LIMIT))
      }
    }

    load(true)
    const interval = setInterval(() => load(false), POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [market.id, market.ticker, market.yesAsk])

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
        {trades.map((trade) => (
          <div
            key={trade.id}
            className={`grid grid-cols-4 gap-2 px-4 py-1.5 text-xs font-mono transition-all duration-300 ${
              newTradeIds.has(trade.id) ? 'bg-terminal-accent/10' : 'hover:bg-terminal-card/50'
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
