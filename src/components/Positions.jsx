import React, { useState, useEffect } from 'react'
import { Briefcase, Trash2, ArrowUpRight, ArrowDownRight } from 'lucide-react'

function formatDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function Positions() {
  const [positions, setPositions] = useState([])

  useEffect(() => {
    const load = () => {
      const data = JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
      setPositions(data.reverse())
    }
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [])

  const clearPositions = () => {
    localStorage.removeItem('predictflow_positions')
    setPositions([])
  }

  if (positions.length === 0) {
    return (
      <div className="bg-terminal-surface border border-terminal-border rounded-lg p-6 text-center">
        <Briefcase size={24} className="mx-auto mb-2 text-terminal-muted" />
        <p className="text-sm text-terminal-muted">No positions yet</p>
        <p className="text-xs text-terminal-muted mt-1">Place a trade to see your positions here</p>
      </div>
    )
  }

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            My Positions
          </h3>
          <span className="text-xs font-mono bg-terminal-card px-2 py-0.5 rounded text-terminal-muted">
            {positions.length}
          </span>
        </div>
        <button
          onClick={clearPositions}
          className="text-terminal-muted hover:text-terminal-red transition-colors"
          title="Clear all positions"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="divide-y divide-terminal-border max-h-80 overflow-y-auto">
        {positions.map((pos, i) => (
          <div key={`${pos.id}-${i}`} className="px-4 py-3 hover:bg-terminal-card transition-colors">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-terminal-muted truncate">{pos.eventTitle}</p>
                <p className="text-sm text-terminal-text font-medium truncate">{pos.question}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {pos.side === 'yes' ? (
                  <ArrowUpRight size={14} className="text-terminal-green" />
                ) : (
                  <ArrowDownRight size={14} className="text-terminal-red" />
                )}
                <span className={`text-xs font-bold uppercase ${
                  pos.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'
                }`}>
                  {pos.side}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-terminal-muted">
              <span className="font-mono">{pos.shares} shares</span>
              <span className="font-mono">@ {(pos.price * 100).toFixed(1)}¢</span>
              <span className="font-mono">${pos.amount.toFixed(2)}</span>
              <span className="ml-auto">{formatDate(pos.timestamp)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
