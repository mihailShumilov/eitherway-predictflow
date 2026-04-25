import React from 'react'
import { Crown, Sparkles, Circle } from 'lucide-react'
import { useUserTier } from '../../hooks/useUserTier'

const STYLES = {
  FREE: {
    container: 'bg-terminal-card border-terminal-border text-terminal-muted',
    icon: Circle,
    iconClass: 'text-terminal-muted',
  },
  PRO: {
    container: 'bg-terminal-accent/10 border-terminal-accent/40 text-terminal-accent shadow-sm shadow-terminal-accent/20',
    icon: Sparkles,
    iconClass: 'text-terminal-accent',
  },
  WHALE: {
    container: 'bg-terminal-yellow/10 border-terminal-yellow/40 text-terminal-yellow shadow-sm shadow-terminal-yellow/20',
    icon: Crown,
    iconClass: 'text-terminal-yellow',
  },
}

export default function TierBadge({ onClick, compact = false }) {
  const { tier } = useUserTier()
  const style = STYLES[tier] || STYLES.FREE
  const Icon = style.icon

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${tier} tier — view pricing`}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider transition-all hover:opacity-80 ${style.container}`}
    >
      <Icon size={10} className={style.iconClass} />
      {!compact && tier}
    </button>
  )
}
