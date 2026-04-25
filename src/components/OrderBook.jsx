import React, { useMemo, useState, useEffect } from 'react'
import { DFLOW_PROXY_BASE, SOLANA_NETWORK } from '../config/env'

const DFLOW_BASE = DFLOW_PROXY_BASE
const ALLOW_MOCK_FALLBACK = (SOLANA_NETWORK || '').toLowerCase() !== 'mainnet'
const LEVELS = 8
const POLL_MS = 5000

// DFlow returns a map of { "<price>": "<size>" }. Convert to sorted (price, size, cumulative-total) rows.
// `mapPrice` lets us flip NO-side prices into YES-equivalent ask prices (1 - p).
function levelsFromMap(map, mapPrice = p => p, sort = 'desc') {
  if (!map || typeof map !== 'object') return []
  const rows = Object.entries(map)
    .map(([p, s]) => {
      const price = mapPrice(parseFloat(p))
      const size = parseFloat(s)
      return Number.isFinite(price) && Number.isFinite(size) && size > 0 ? { price, size } : null
    })
    .filter(Boolean)
  rows.sort((a, b) => sort === 'asc' ? a.price - b.price : b.price - a.price)
  let cum = 0
  return rows.slice(0, LEVELS).map(r => {
    cum += r.size
    return { ...r, total: cum }
  })
}

// Synthetic placeholder used only on devnet when the real endpoint fails. Marked
// visibly so it can't be mistaken for live depth.
function syntheticLevels(basePrice, side) {
  const rows = []
  let cum = 0
  for (let i = 0; i < LEVELS; i++) {
    const offset = (i + 1) * 0.01
    const price = side === 'bid' ? Math.max(0.01, basePrice - offset) : Math.min(0.99, basePrice + offset)
    const size = Math.floor(Math.random() * 50000 + 5000)
    cum += size
    rows.push({ price, size, total: cum })
  }
  return rows
}

export default function OrderBook({ market }) {
  const [book, setBook] = useState({ bids: [], asks: [], synthetic: false, loaded: false })

  useEffect(() => {
    let cancelled = false
    const ticker = market.ticker || market.id
    if (!ticker) return

    async function load() {
      try {
        const res = await fetch(`${DFLOW_BASE}/api/v1/orderbook/${encodeURIComponent(ticker)}`)
        if (!res.ok) throw new Error(`orderbook ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        const bids = levelsFromMap(data.yes_bids, p => p, 'desc')
        const asks = levelsFromMap(data.no_bids, p => 1 - p, 'asc')
        setBook({ bids, asks, synthetic: false, loaded: true })
      } catch {
        if (cancelled) return
        if (ALLOW_MOCK_FALLBACK) {
          setBook({
            bids: syntheticLevels(market.yesBid, 'bid'),
            asks: syntheticLevels(market.yesAsk, 'ask'),
            synthetic: true,
            loaded: true,
          })
        } else {
          setBook({ bids: [], asks: [], synthetic: false, loaded: true })
        }
      }
    }

    load()
    const interval = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [market.id, market.ticker, market.yesBid, market.yesAsk])

  const { bids, asks, synthetic, loaded } = book
  const maxTotal = useMemo(
    () => Math.max(bids[bids.length - 1]?.total || 0, asks[asks.length - 1]?.total || 0, 1),
    [bids, asks],
  )

  const bestBid = bids[0]?.price ?? market.yesBid
  const bestAsk = asks[0]?.price ?? market.yesAsk
  const empty = loaded && bids.length === 0 && asks.length === 0

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Order Book
          </h3>
          {synthetic && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-terminal-yellow/10 border-terminal-yellow/30 text-terminal-yellow">
              demo depth
            </span>
          )}
        </div>
        <span className="text-xs text-terminal-muted font-mono">YES</span>
      </div>

      {empty ? (
        <div className="px-4 py-6 text-center text-xs text-terminal-muted">
          No resting orders on this book.
        </div>
      ) : (
        <div className="px-4 py-2">
          <div className="grid grid-cols-3 gap-2 text-[10px] text-terminal-muted uppercase tracking-wider mb-1 px-1">
            <span>Size</span>
            <span className="text-center">Price</span>
            <span className="text-right">Total</span>
          </div>

          <div className="space-y-px">
            {[...asks].reverse().map((level, i) => (
              <div key={`ask-${i}`} className="relative grid grid-cols-3 gap-2 text-xs font-mono py-1 px-1 rounded">
                <div
                  className="absolute inset-0 bg-terminal-red/10 rounded"
                  style={{ width: `${(level.total / maxTotal) * 100}%`, right: 0, left: 'auto' }}
                />
                <span className="relative text-terminal-text">{level.size.toLocaleString()}</span>
                <span className="relative text-center text-terminal-red">{(level.price * 100).toFixed(1)}¢</span>
                <span className="relative text-right text-terminal-muted">{level.total.toLocaleString()}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-center gap-4 py-2 my-1 border-y border-terminal-border">
            <span className="text-sm font-mono font-bold text-terminal-green">
              {(bestBid * 100).toFixed(1)}¢
            </span>
            <span className="text-terminal-muted text-xs">|</span>
            <span className="text-sm font-mono font-bold text-terminal-red">
              {(bestAsk * 100).toFixed(1)}¢
            </span>
            <span className="text-[10px] text-terminal-muted">
              spread: {((bestAsk - bestBid) * 100).toFixed(1)}¢
            </span>
          </div>

          <div className="space-y-px">
            {bids.map((level, i) => (
              <div key={`bid-${i}`} className="relative grid grid-cols-3 gap-2 text-xs font-mono py-1 px-1 rounded">
                <div
                  className="absolute inset-0 bg-terminal-green/10 rounded"
                  style={{ width: `${(level.total / maxTotal) * 100}%` }}
                />
                <span className="relative text-terminal-text">{level.size.toLocaleString()}</span>
                <span className="relative text-center text-terminal-green">{(level.price * 100).toFixed(1)}¢</span>
                <span className="relative text-right text-terminal-muted">{level.total.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
