import React, { useEffect, useMemo, useState } from 'react'
import { DollarSign, BarChart3, TrendingUp, Users, Lock, AlertCircle } from 'lucide-react'
import { useWallet } from '../hooks/useWallet'
import { getFeeLog, summarizeFeeLog, clearFeeLog } from '../lib/feeLog'
import { FEE_CONFIG, isFeeWalletConfigured } from '../config/fees'

// Hidden ops view — only the fee wallet operator (or anyone using the same
// connected wallet pubkey, in dev) can see real numbers. Everyone else gets
// a polite "not authorized" empty state.
export default function AdminRevenuePage() {
  const { address } = useWallet()
  const [log, setLog] = useState([])

  useEffect(() => {
    setLog(getFeeLog())
    const handler = () => setLog(getFeeLog())
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const summary = useMemo(() => summarizeFeeLog(log), [log])

  const authorized = isFeeWalletConfigured()
    ? address === FEE_CONFIG.FEE_WALLET
    : !!address // demo mode — any connected wallet can view

  if (!authorized) {
    return (
      <div className="bg-terminal-surface border border-terminal-border rounded-lg p-12 text-center">
        <Lock size={32} className="mx-auto mb-3 text-terminal-muted" />
        <h3 className="text-lg font-semibold text-terminal-text mb-2">Restricted</h3>
        <p className="text-sm text-terminal-muted">
          This dashboard is visible only to the configured fee wallet operator.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5 py-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-terminal-text">Revenue Dashboard</h2>
          <p className="text-xs text-terminal-muted font-mono">
            {isFeeWalletConfigured()
              ? `Fee wallet: ${FEE_CONFIG.FEE_WALLET.slice(0, 6)}…${FEE_CONFIG.FEE_WALLET.slice(-4)}`
              : 'Demo mode — fee wallet not configured'}
          </p>
        </div>
        <button
          onClick={() => { clearFeeLog(); setLog([]) }}
          className="px-3 py-1.5 text-xs bg-terminal-card border border-terminal-border rounded-lg text-terminal-muted hover:text-terminal-red hover:border-terminal-red/50 transition-all"
        >
          Clear log
        </button>
      </div>

      {!isFeeWalletConfigured() && (
        <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg px-3 py-2 text-xs text-terminal-yellow">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            Fee wallet placeholder is in use. Numbers below show <strong>recorded intent</strong>,
            not on-chain receipts. Set <code className="font-mono">VITE_FEE_WALLET</code> for live revenue.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={DollarSign} label="Total fees" value={`$${summary.total.toFixed(2)}`} tone="text-terminal-green" />
        <Stat icon={TrendingUp} label="Today" value={`$${summary.today.toFixed(2)}`} />
        <Stat icon={BarChart3} label="This week" value={`$${summary.week.toFixed(2)}`} />
        <Stat icon={Users} label="Trades" value={summary.trades} sub={`avg $${summary.avgPerTrade.toFixed(4)}`} />
      </div>

      <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-terminal-border">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Tier distribution
          </h3>
        </div>
        <div className="p-4 grid grid-cols-3 gap-3">
          {Object.entries(summary.tierCounts).map(([key, count]) => {
            const total = Math.max(1, summary.trades)
            const pct = ((count / total) * 100).toFixed(1)
            return (
              <div key={key} className="bg-terminal-card border border-terminal-border rounded-lg p-3">
                <div className="text-[10px] uppercase tracking-wider text-terminal-muted mb-1">{key}</div>
                <div className="text-xl font-mono font-bold text-terminal-text">{count}</div>
                <div className="text-[10px] text-terminal-muted">{pct}% of trades</div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Recent fee events
          </h3>
          <span className="text-[10px] text-terminal-muted font-mono">
            referral split: ${summary.referralTotal.toFixed(2)} · this month: ${summary.month.toFixed(2)}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-left text-[10px] text-terminal-muted uppercase tracking-wider border-b border-terminal-border/50">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium text-right">Input</th>
                <th className="px-4 py-2 font-medium text-right">Fee</th>
                <th className="px-4 py-2 font-medium text-right">Platform</th>
                <th className="px-4 py-2 font-medium text-right">Referral</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-border/50">
              {log.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-terminal-muted text-xs">
                    No fee events yet — place a trade to see entries here.
                  </td>
                </tr>
              ) : (
                [...log].reverse().slice(0, 50).map((entry, i) => (
                  <tr key={`${entry.timestamp}-${i}`} className="hover:bg-terminal-card/50 transition-colors">
                    <td className="px-4 py-2 text-terminal-muted text-[10px]">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-terminal-text">{entry.tier || '—'}</td>
                    <td className="px-4 py-2 text-right text-terminal-text">
                      {entry.inputAmount ? `$${Number(entry.inputAmount).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-terminal-yellow">
                      {entry.feeAmount ? `$${Number(entry.feeAmount).toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-terminal-green">
                      {entry.platformAmount ? `$${Number(entry.platformAmount).toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-terminal-cyan">
                      {entry.referralAmount ? `$${Number(entry.referralAmount).toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        entry.feeStatus === 'sent'
                          ? 'bg-terminal-green/10 border-terminal-green/30 text-terminal-green'
                          : entry.feeStatus === 'failed'
                            ? 'bg-terminal-red/10 border-terminal-red/30 text-terminal-red'
                            : 'bg-terminal-muted/10 border-terminal-muted/30 text-terminal-muted'
                      }`}>
                        {entry.feeStatus || entry.kind || '—'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value, sub, tone = 'text-terminal-text' }) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-terminal-muted uppercase tracking-wider mb-2">
        <Icon size={12} />
        {label}
      </div>
      <div className={`text-2xl font-mono font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-terminal-muted mt-1 font-mono">{sub}</div>}
    </div>
  )
}
