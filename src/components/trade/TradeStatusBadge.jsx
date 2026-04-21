import React from 'react'
import { Lock, Wallet, ShieldAlert, ShieldCheck } from 'lucide-react'

export default function TradeStatusBadge({ isClosed, connected, kycVerified }) {
  if (isClosed) {
    return (
      <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-muted/10 border border-terminal-muted/40 text-terminal-muted">
        <Lock size={10} />
        Trading Closed
      </span>
    )
  }
  if (!connected) {
    return (
      <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-yellow/10 border border-terminal-yellow/30 text-terminal-yellow">
        <Wallet size={10} />
        Wallet Required
      </span>
    )
  }
  if (!kycVerified) {
    return (
      <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-accent/10 border border-terminal-accent/30 text-terminal-accent">
        <ShieldAlert size={10} />
        KYC Required
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-terminal-green/10 border border-terminal-green/30 text-terminal-green">
      <ShieldCheck size={10} />
      Verified
    </span>
  )
}
