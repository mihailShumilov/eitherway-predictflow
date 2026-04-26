import React from 'react'
import { ArrowUpDown, Zap } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'

const sortOptions = [
  { value: 'volume', label: 'Volume' },
  { value: 'closeTime', label: 'Closing Soon' },
  { value: 'yesPrice', label: 'YES Price' },
  { value: 'noPrice', label: 'NO Price' },
]

export default function SortBar() {
  const { sortBy, setSortBy, markets, selectedCategory, tradeableOnly, setTradeableOnly } = useMarkets()

  return (
    <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-terminal-text">
          {selectedCategory === 'All' ? 'All Markets' : selectedCategory}
        </h2>
        <span className="text-xs font-mono text-terminal-muted bg-terminal-card px-2 py-0.5 rounded">
          {markets.length}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setTradeableOnly(!tradeableOnly)}
          aria-pressed={tradeableOnly}
          title={tradeableOnly ? 'Showing only tradeable markets' : 'Show all markets'}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
            tradeableOnly
              ? 'bg-terminal-green/15 border-terminal-green/40 text-terminal-green'
              : 'bg-terminal-card border-terminal-border text-terminal-muted hover:text-terminal-text'
          }`}
        >
          <Zap size={12} className={tradeableOnly ? 'fill-current' : ''} />
          Tradeable only
        </button>
        <ArrowUpDown size={14} className="text-terminal-muted" />
        <div className="flex bg-terminal-card border border-terminal-border rounded-lg overflow-hidden">
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                sortBy === opt.value
                  ? 'bg-terminal-accent text-white'
                  : 'text-terminal-muted hover:text-terminal-text'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
