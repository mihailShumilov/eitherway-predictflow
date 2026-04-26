import React, { useMemo, useState, useEffect } from 'react'
import { DFLOW_PROXY_BASE, SOLANA_NETWORK } from '../config/env'
import { useConditionalOrders } from '../hooks/useConditionalOrders'

const DFLOW_BASE = DFLOW_PROXY_BASE
const ALLOW_MOCK_FALLBACK = (SOLANA_NETWORK || '').toLowerCase() !== 'mainnet'
const LEVELS = 8
const POLL_MS = 5000
// Round prices when bucketing user orders into book levels — a 0.123 trigger
// shouldn't show as a separate row from a 0.12 DFlow level.
const PRICE_BUCKET = 0.001

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
  return rows
}

// Synthetic placeholder used only on devnet when the real endpoint fails. Marked
// visibly so it can't be mistaken for live depth.
function syntheticLevels(basePrice, side) {
  const rows = []
  for (let i = 0; i < LEVELS; i++) {
    const offset = (i + 1) * 0.01
    const price = side === 'bid' ? Math.max(0.01, basePrice - offset) : Math.min(0.99, basePrice + offset)
    const size = Math.floor(Math.random() * 50000 + 5000)
    rows.push({ price, size })
  }
  return rows
}

// Bucket user limit orders into book-shaped levels for the YES-centric view.
// YES limit BUY → YES bid at trigger.  NO limit BUY → YES ask at (1 - trigger).
// (A NO buy is economically the same as offering YES for sale at 1-p.)
function userLevelsForSide(orders, marketId, sideFilter) {
  const buckets = new Map()
  for (const o of orders) {
    if (o.marketId !== marketId) continue
    if (o.status !== 'pending') continue
    if (o.orderType !== 'limit') continue
    if (o.side !== sideFilter) continue
    if (!Number.isFinite(o.triggerPrice) || o.triggerPrice <= 0) continue
    const price = sideFilter === 'yes' ? o.triggerPrice : 1 - o.triggerPrice
    const shares = (o.amount || 0) / o.triggerPrice
    if (!Number.isFinite(shares) || shares <= 0) continue
    const key = Math.round(price / PRICE_BUCKET) * PRICE_BUCKET
    const cur = buckets.get(key) || { price: key, size: 0, mine: true }
    cur.size += shares
    buckets.set(key, cur)
  }
  return Array.from(buckets.values())
}

// Merge user levels into book levels at matching price buckets, then sort
// and slice to LEVELS. We round prices to PRICE_BUCKET so a $1 limit at
// "1.0¢" lines up with DFlow's "1.0¢" level instead of orphaning its own row.
function mergeLevels(bookLevels, userLevels, sort) {
  const map = new Map()
  for (const lvl of bookLevels) {
    const key = Math.round(lvl.price / PRICE_BUCKET) * PRICE_BUCKET
    map.set(key, { price: key, size: lvl.size, mine: false, mineSize: 0 })
  }
  for (const lvl of userLevels) {
    const key = Math.round(lvl.price / PRICE_BUCKET) * PRICE_BUCKET
    const cur = map.get(key) || { price: key, size: 0, mine: false, mineSize: 0 }
    cur.size += lvl.size
    cur.mine = true
    cur.mineSize += lvl.size
    map.set(key, cur)
  }
  const merged = Array.from(map.values())
  merged.sort((a, b) => sort === 'asc' ? a.price - b.price : b.price - a.price)
  let cum = 0
  return merged.slice(0, LEVELS).map(r => {
    cum += r.size
    return { ...r, total: cum }
  })
}

export default function OrderBook({ market }) {
  const [book, setBook] = useState({ bids: [], asks: [], synthetic: false, loaded: false })
  const { orders } = useConditionalOrders()

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

  const myYesBids = useMemo(
    () => userLevelsForSide(orders, market.id, 'yes'),
    [orders, market.id],
  )
  const myYesAsks = useMemo(
    () => userLevelsForSide(orders, market.id, 'no'),
    [orders, market.id],
  )
  const hasMyOrders = myYesBids.length > 0 || myYesAsks.length > 0

  const bids = useMemo(
    () => mergeLevels(book.bids, myYesBids, 'desc'),
    [book.bids, myYesBids],
  )
  const asks = useMemo(
    () => mergeLevels(book.asks, myYesAsks, 'asc'),
    [book.asks, myYesAsks],
  )
  const { synthetic, loaded } = book
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
          {hasMyOrders && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-terminal-accent/10 border-terminal-accent/30 text-terminal-accent"
              title="Your pending limit orders are highlighted on this book"
            >
              your orders
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
              <BookRow key={`ask-${i}`} level={level} side="ask" maxTotal={maxTotal} />
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
              <BookRow key={`bid-${i}`} level={level} side="bid" maxTotal={maxTotal} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BookRow({ level, side, maxTotal }) {
  const priceColor = side === 'ask' ? 'text-terminal-red' : 'text-terminal-green'
  const fillColor = side === 'ask' ? 'bg-terminal-red/10' : 'bg-terminal-green/10'
  const tooltip = level.mine
    ? `Includes your pending limit order (${level.mineSize.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares @ ${(level.price * 100).toFixed(1)}¢)`
    : undefined
  return (
    <div
      className={`relative grid grid-cols-3 gap-2 text-xs font-mono py-1 px-1 rounded ${
        level.mine ? 'ring-1 ring-terminal-accent/40' : ''
      }`}
      title={tooltip}
    >
      <div
        className={`absolute inset-0 ${fillColor} rounded`}
        style={
          side === 'ask'
            ? { width: `${(level.total / maxTotal) * 100}%`, right: 0, left: 'auto' }
            : { width: `${(level.total / maxTotal) * 100}%` }
        }
      />
      <span className="relative text-terminal-text flex items-center gap-1">
        {level.size.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        {level.mine && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1 py-px rounded bg-terminal-accent/20 text-terminal-accent">
            you
          </span>
        )}
      </span>
      <span className={`relative text-center ${priceColor}`}>{(level.price * 100).toFixed(1)}¢</span>
      <span className="relative text-right text-terminal-muted">
        {level.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  )
}
