import React, { useMemo } from 'react'

function generateOrderBookLevels(basePrice, side, levels = 8) {
  const rows = []
  for (let i = 0; i < levels; i++) {
    const offset = (i + 1) * 0.01
    const price = side === 'bid'
      ? Math.max(0.01, basePrice - offset)
      : Math.min(0.99, basePrice + offset)
    const size = Math.floor(Math.random() * 50000 + 5000)
    const total = rows.reduce((sum, r) => sum + r.size, 0) + size
    rows.push({ price, size, total })
  }
  return rows
}

export default function OrderBook({ market }) {
  const bids = useMemo(() => generateOrderBookLevels(market.yesBid, 'bid'), [market.id])
  const asks = useMemo(() => generateOrderBookLevels(market.yesAsk, 'ask'), [market.id])

  const maxTotal = Math.max(
    bids[bids.length - 1]?.total || 0,
    asks[asks.length - 1]?.total || 0
  )

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Order Book
        </h3>
        <span className="text-xs text-terminal-muted font-mono">YES / NO</span>
      </div>

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
            {(market.yesBid * 100).toFixed(1)}¢
          </span>
          <span className="text-terminal-muted text-xs">|</span>
          <span className="text-sm font-mono font-bold text-terminal-red">
            {(market.yesAsk * 100).toFixed(1)}¢
          </span>
          <span className="text-[10px] text-terminal-muted">
            spread: {((market.yesAsk - market.yesBid) * 100).toFixed(1)}¢
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
    </div>
  )
}
