import React from 'react'

function Shimmer({ className = '' }) {
  return (
    <div
      className={`rounded animate-shimmer ${className}`}
      style={{
        backgroundImage: 'linear-gradient(90deg, rgba(30,39,64,0.25) 0%, rgba(30,39,64,0.55) 50%, rgba(30,39,64,0.25) 100%)',
        backgroundSize: '600px 100%',
      }}
    />
  )
}

export default function MarketCardSkeleton() {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0 space-y-2">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="h-4 w-full" />
          <Shimmer className="h-4 w-3/4" />
        </div>
        <Shimmer className="h-5 w-14 rounded" />
      </div>
      <Shimmer className="h-2 w-full rounded-full mb-3" />
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Shimmer className="h-9 rounded-lg" />
        <Shimmer className="h-9 rounded-lg" />
      </div>
      <div className="flex items-center justify-between">
        <Shimmer className="h-3 w-20" />
        <Shimmer className="h-3 w-24" />
      </div>
    </div>
  )
}
