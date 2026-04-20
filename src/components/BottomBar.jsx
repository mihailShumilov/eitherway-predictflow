import React, { useState, useEffect } from 'react'
import { Activity, Clock } from 'lucide-react'

function DflowLogo({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="dflow-logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <path
        d="M3 8 L11 4 L21 8 L21 16 L13 20 L3 16 Z"
        fill="url(#dflow-logo-gradient)"
        opacity="0.9"
      />
      <path
        d="M7 11 L11 9 L15 11 L15 14 L11 16 L7 14 Z"
        fill="#fff"
        opacity="0.9"
      />
    </svg>
  )
}

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
        <a
          href="https://dflow.net"
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:flex items-center gap-1.5 px-2 py-0.5 rounded border border-terminal-border bg-terminal-card/50 hover:border-terminal-accent/50 hover:bg-terminal-card transition-all group"
          title="DFlow — prediction market infrastructure on Solana"
        >
          <DflowLogo size={11} />
          <span className="text-terminal-muted group-hover:text-terminal-text transition-colors">
            Powered by
          </span>
          <span className="text-terminal-text font-semibold tracking-wide">DFlow</span>
        </a>
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden sm:flex items-center gap-1" title="Running on Solana devnet">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
          Devnet
        </span>
        <span className="flex items-center gap-1" title="Current time">
          <Clock size={10} />
          {time.toLocaleTimeString()}
        </span>
      </div>
    </footer>
  )
}
