import React from 'react'
import { Repeat, StopCircle } from 'lucide-react'
import { DCA_FREQUENCIES } from '../../hooks/useDCA'

function formatDcaTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function shortSig(sig) {
  if (!sig || sig === 'signed' || sig === 'simulated') return sig || '—'
  return `${sig.slice(0, 6)}…${sig.slice(-4)}`
}

export default function DcaProgress({ strategy, onStop, compact = false }) {
  const completed = strategy.executions.length
  const total = strategy.totalPurchases
  const spent = strategy.executions.reduce((s, e) => s + e.amount, 0)
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0
  const isActive = strategy.status === 'active'
  const nextRun = strategy.nextRunAt ? new Date(strategy.nextRunAt) : null
  const now = Date.now()
  const nextLabel = nextRun
    ? (nextRun.getTime() <= now ? 'firing now…' : `in ${Math.max(1, Math.round((nextRun.getTime() - now) / 60000))} min`)
    : null

  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Repeat size={12} className={isActive ? 'text-terminal-accent' : 'text-terminal-muted'} />
          <span className="text-xs font-semibold text-terminal-text uppercase tracking-wider">
            {isActive ? 'DCA Active' : strategy.status === 'completed' ? 'DCA Completed' : 'DCA Cancelled'}
          </span>
          <span className={`text-[10px] font-bold uppercase ${strategy.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {strategy.side}
          </span>
        </div>
        {isActive && onStop && (
          <button
            onClick={onStop}
            className="flex items-center gap-1 text-[10px] text-terminal-red/80 hover:text-terminal-red transition-colors"
          >
            <StopCircle size={12} />
            Stop DCA
          </button>
        )}
      </div>

      <div className="text-xs text-terminal-text font-mono">
        {completed} of {total} purchases completed (${spent.toFixed(2)} / ${strategy.totalBudget.toFixed(2)})
      </div>

      <div className="h-1.5 bg-terminal-surface rounded-full overflow-hidden">
        <div
          className={`h-full ${strategy.status === 'cancelled' ? 'bg-terminal-muted' : 'bg-terminal-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-terminal-muted font-mono">
        <span>
          ${strategy.amountPerBuy.toFixed(2)} · every {DCA_FREQUENCIES.find(f => f.key === strategy.frequency)?.label}
        </span>
        {isActive && nextLabel && <span>Next: {nextLabel}</span>}
      </div>

      {!compact && strategy.executions.length > 0 && (
        <div className="pt-2 border-t border-terminal-border/50">
          <p className="text-[10px] text-terminal-muted uppercase tracking-wider mb-1">History</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {strategy.executions.slice().reverse().map(e => (
              <div key={e.id} className="flex items-center justify-between text-[10px] font-mono text-terminal-muted gap-2">
                <span>{formatDcaTime(e.timestamp)}</span>
                <span className="text-terminal-text">${e.amount.toFixed(2)}</span>
                <span>@{(e.price * 100).toFixed(1)}¢</span>
                <span className={e.txSigned ? 'text-terminal-green' : 'text-terminal-yellow'} title={e.txSignature}>
                  {e.txSigned ? shortSig(e.txSignature) : 'sim'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
