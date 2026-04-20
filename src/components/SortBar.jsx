import React from 'react'
import { ArrowUpDown } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'

const sortOptions = [
  { value: 'volume', label: 'Volume' },
  { value: 'closeTime', label: 'Closing Soon' },
  { value: 'yesPrice', label: 'YES Price' },
  { value: 'noPrice', label: 'NO Price' },
]

export default function SortBar() {
  const { sortBy, setSortBy, markets, selectedCategory } = useMarkets()

  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-terminal-text">
          {selectedCategory === 'All' ? 'All Markets' : selectedCategory}
        </h2>
        <span className="text-xs font-mono text-terminal-muted bg-terminal-card px-2 py-0.5 rounded">
          {markets.length}
        </span>
      </div>
      <div className="flex items-center gap-2">
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
