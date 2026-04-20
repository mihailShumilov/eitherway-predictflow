import React from 'react'
import { SearchX, AlertTriangle, RefreshCw } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'
import MarketCard from './MarketCard'
import MarketCardSkeleton from './MarketCardSkeleton'
import SortBar from './SortBar'

export default function MarketGrid({ onSelectMarket }) {
  const { markets, loading, error, usingMockData, searchQuery, refresh } = useMarkets()

  if (loading && markets.length === 0) {
    return (
      <div className="flex-1">
        <SortBar />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <MarketCardSkeleton key={i} />
          ))}
        </div>
      </div>
    )
  }

  if (error && usingMockData && markets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-12 h-12 rounded-full bg-terminal-yellow/10 border border-terminal-yellow/30 flex items-center justify-center mb-3">
          <AlertTriangle size={20} className="text-terminal-yellow" />
        </div>
        <p className="text-sm font-semibold text-terminal-text mb-1">Can't reach DFlow right now</p>
        <p className="text-xs text-terminal-muted mb-4 text-center max-w-sm">
          We'll show demo markets in the meantime. Retry to fetch live data.
        </p>
        <button
          onClick={refresh}
          className="flex items-center gap-2 px-4 py-2 bg-terminal-accent hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors min-h-[44px]"
        >
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    )
  }

  if (markets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <SearchX size={32} className="text-terminal-muted mb-3" />
        <p className="text-sm text-terminal-muted">No markets found</p>
        {searchQuery && (
          <p className="text-xs text-terminal-muted mt-1">
            Try adjusting your search or category filter
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1">
      <SortBar />
      {error && usingMockData && (
        <div className="mb-3 flex items-center justify-between gap-3 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg px-3 py-2 text-xs">
          <span className="flex items-center gap-2 text-terminal-yellow">
            <AlertTriangle size={12} />
            Showing demo data — DFlow API unavailable.
          </span>
          <button
            onClick={refresh}
            className="flex items-center gap-1 text-terminal-yellow hover:text-white transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {markets.map((market) => (
          <MarketCard
            key={market.id}
            market={market}
            onSelect={onSelectMarket}
          />
        ))}
      </div>
    </div>
  )
}
