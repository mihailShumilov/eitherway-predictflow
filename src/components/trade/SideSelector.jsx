import React from 'react'
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react'

export default function SideSelector({ side, onChange, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={() => onChange('yes')}
        disabled={disabled}
        className={`flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${
          side === 'yes'
            ? 'bg-terminal-green text-white shadow-lg shadow-terminal-green/20'
            : 'bg-terminal-green/10 text-terminal-green border border-terminal-green/30 hover:bg-terminal-green/20'
        }`}
      >
        <ArrowUpCircle size={16} />
        BUY YES
      </button>
      <button
        onClick={() => onChange('no')}
        disabled={disabled}
        className={`flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${
          side === 'no'
            ? 'bg-terminal-red text-white shadow-lg shadow-terminal-red/20'
            : 'bg-terminal-red/10 text-terminal-red border border-terminal-red/30 hover:bg-terminal-red/20'
        }`}
      >
        <ArrowDownCircle size={16} />
        BUY NO
      </button>
    </div>
  )
}
