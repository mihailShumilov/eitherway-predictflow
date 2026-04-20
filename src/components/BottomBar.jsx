import React, { useState, useEffect } from 'react'
import { Activity, Clock, Zap } from 'lucide-react'

export default function BottomBar() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <footer className="bg-terminal-surface border-t border-terminal-border px-4 py-2 flex items-center justify-between text-[11px] text-terminal-muted font-mono">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          <Activity size={10} className="text-terminal-accent" />
          PredictFlow v1.0
        </span>
        <span className="hidden sm:flex items-center gap-1">
          <Zap size={10} className="text-terminal-green" />
          Powered by DFlow on Solana
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden sm:block">Devnet</span>
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {time.toLocaleTimeString()}
        </span>
      </div>
    </footer>
  )
}
