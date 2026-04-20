import React from 'react'
import { Loader2, SearchX } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'
import MarketCard from './MarketCard'
import SortBar from './SortBar'

export default function MarketGrid({ onSelectMarket }) {
  const { markets, loading, searchQuery } = useMarkets()

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 size={32} className="text-terminal-accent animate-spin mb-3" />
        <p className="text-sm text-terminal-muted">Loading markets...</p>
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
