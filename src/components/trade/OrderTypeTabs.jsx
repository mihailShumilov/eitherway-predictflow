import React from 'react'
import { Zap, Target, TrendingDown, TrendingUp, Repeat } from 'lucide-react'

export const ORDER_TABS = [
  { key: 'market', label: 'Market', icon: Zap },
  { key: 'limit', label: 'Limit', icon: Target },
  { key: 'stop-loss', label: 'Stop-Loss', icon: TrendingDown },
  { key: 'take-profit', label: 'Take-Profit', icon: TrendingUp },
  { key: 'dca', label: 'DCA', icon: Repeat },
]

export default function OrderTypeTabs({ tabs, activeKey, onChange }) {
  return (
    <div className="flex bg-terminal-card border border-terminal-border rounded-lg overflow-hidden">
      {tabs.map(tab => {
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-[10px] font-medium uppercase tracking-wider transition-all ${
              activeKey === tab.key
                ? 'bg-terminal-highlight text-terminal-accent'
                : 'text-terminal-muted hover:text-terminal-text'
            }`}
          >
            <Icon size={10} />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
