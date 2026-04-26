import React, { useState, useEffect, useRef } from 'react'
import { ArrowUpRight, ArrowDownRight, Zap } from 'lucide-react'
import { generateRecentTrades } from '../data/mockDetailData'
import Skeleton from './Skeleton'
import { normalizeTrade } from '../lib/normalize'
import { subscribeLocalTrades } from '../lib/tradeEvents'
import { DFLOW_PROXY_BASE, SOLANA_NETWORK } from '../config/env'

const DFLOW_BASE = DFLOW_PROXY_BASE
const ALLOW_MOCK_FALLBACK = (SOLANA_NETWORK || '').toLowerCase() !== 'mainnet'
const POLL_MS = 8000
const TRADE_LIMIT = 20
// How long an optimistic row sticks around before we give up waiting for
// DFlow's indexer to surface the real trade and just drop it.
const OPTIMISTIC_TTL_MS = 60_000
// Fast follow-up polls after a local trade lands. The 8s background poll is
// too slow — the user just signed and wants to see their fill replace the
// optimistic row promptly.
const FAST_REPOLL_DELAYS_MS = [1500, 4000]

function formatTradeTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// True when a remote trade looks like the indexed copy of an optimistic one:
// same direction, similar size, similar price, and within a short window.
function matchesRemote(local, remote) {
  if (!local || !remote) return false
  if (local.side !== remote.side) return false
  const dt = Math.abs(new Date(remote.time).getTime() - new Date(local.time).getTime())
  if (dt > 30_000) return false
  if (Math.abs(remote.price - local.price) > 0.005) return false
  const denom = Math.max(local.amount, 1)
  if (Math.abs(remote.amount - local.amount) / denom > 0.1) return false
  return true
}

export default function RecentTrades({ market }) {
  const [trades, setTrades] = useState([])
  const [optimistic, setOptimistic] = useState([])
  const [newTradeIds, setNewTradeIds] = useState(() => new Set())
  const seenIdsRef = useRef(new Set())
  const loadRef = useRef(null)

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
          // Even with empty remote, prune expired optimistics.
          setOptimistic((prev) => prev.filter((o) => Date.now() < o._expiresAt))
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
        // Drop optimistic rows that the indexer has now confirmed (or that
        // simply expired). Keeps the tape from flashing the same fill twice.
        setOptimistic((prev) =>
          prev.filter((o) =>
            Date.now() < o._expiresAt && !mapped.some((r) => matchesRemote(o, r)),
          ),
        )
      } catch {
        if (cancelled) return
        if (isFirst && ALLOW_MOCK_FALLBACK) setTrades(generateRecentTrades(market.yesAsk, TRADE_LIMIT))
      }
    }

    loadRef.current = load
    load(true)
    const interval = setInterval(() => load(false), POLL_MS)
    return () => { cancelled = true; clearInterval(interval); loadRef.current = null }
  }, [market.id, market.ticker, market.yesAsk])

  // Subscribe to local trade events from useTradeSubmit. We prepend an
  // optimistic row immediately, then schedule fast re-polls so DFlow's
  // indexed copy can replace it well before the next 8s tick.
  useEffect(() => {
    const ticker = market.ticker || market.id
    if (!ticker) return
    return subscribeLocalTrades((t) => {
      if (!t) return
      if (t.ticker !== ticker && t.marketId !== market.id) return
      const row = {
        id: t.id,
        time: t.time,
        side: t.side,
        price: t.price,
        amount: Math.max(0, Number(t.amount) || 0),
        total: Math.round(t.price * (Number(t.amount) || 0) * 100) / 100,
        _local: true,
        _expiresAt: Date.now() + OPTIMISTIC_TTL_MS,
      }
      setOptimistic((prev) => [row, ...prev.filter((x) => x.id !== row.id)])
      setNewTradeIds((prev) => new Set([...prev, row.id]))
      setTimeout(() => {
        setNewTradeIds((prev) => {
          const next = new Set(prev)
          next.delete(row.id)
          return next
        })
      }, 600)
      // Fire-and-forget fast re-polls. If the component unmounts first,
      // loadRef.current is nulled in the polling effect's cleanup and these
      // become no-ops — the inner `cancelled` guard prevents stale state writes.
      FAST_REPOLL_DELAYS_MS.forEach((d) =>
        setTimeout(() => loadRef.current?.(false), d),
      )
    })
  }, [market.id, market.ticker])

  const merged = [...optimistic, ...trades]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, TRADE_LIMIT)

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
        {merged.length === 0 && (
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
        {merged.map((trade) => (
          <div
            key={trade.id}
            className={`grid grid-cols-4 gap-2 px-4 py-1.5 text-xs font-mono transition-all duration-300 ${
              newTradeIds.has(trade.id) ? 'bg-terminal-accent/10' : 'hover:bg-terminal-card/50'
            } ${trade._local ? 'ring-1 ring-terminal-accent/40' : ''}`}
            title={trade._local ? 'Your order — pending indexer confirmation' : undefined}
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
