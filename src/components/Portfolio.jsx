import React from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  Wallet, TrendingUp, TrendingDown, DollarSign, Briefcase,
  RefreshCw, Loader2, AlertCircle, ArrowUpRight, ArrowDownRight, Clock,
} from 'lucide-react'
import { useWallet } from '../hooks/useWallet'
import { usePortfolio } from '../hooks/usePortfolio'
import { useConditionalOrders } from '../hooks/useConditionalOrders'
import ActiveOrders from './ActiveOrders'

function daysUntil(iso) {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  return ms / 86400000
}

function settlementColor(days) {
  if (days == null) return { text: 'text-terminal-muted', bg: 'bg-terminal-muted/10', border: 'border-terminal-muted/30', label: 'Unknown' }
  if (days < 1) return { text: 'text-terminal-red', bg: 'bg-terminal-red/10', border: 'border-terminal-red/30', label: '<24h' }
  if (days <= 7) return { text: 'text-terminal-yellow', bg: 'bg-terminal-yellow/10', border: 'border-terminal-yellow/30', label: `${Math.ceil(days)}d` }
  return { text: 'text-terminal-green', bg: 'bg-terminal-green/10', border: 'border-terminal-green/30', label: `${Math.ceil(days)}d` }
}

function StatCard({ icon: Icon, label, value, tone = 'text-terminal-text', sub }) {
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

function SettlementTimeline({ positions }) {
  const items = positions
    .filter(p => p.closeTime)
    .map(p => ({ ...p, days: daysUntil(p.closeTime) }))
    .sort((a, b) => a.days - b.days)

  if (items.length === 0) {
    return (
      <div className="bg-terminal-surface border border-terminal-border rounded-lg p-6 text-center">
        <Clock size={20} className="mx-auto mb-2 text-terminal-muted" />
        <p className="text-sm text-terminal-muted">No settlement dates available</p>
      </div>
    )
  }

  const maxDays = Math.max(30, ...items.map(i => i.days))

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center gap-2">
        <Clock size={12} className="text-terminal-muted" />
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Settlement Timeline
        </h3>
        <div className="ml-auto flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 text-terminal-green"><span className="w-2 h-2 rounded-full bg-terminal-green" />&gt;7d</span>
          <span className="flex items-center gap-1 text-terminal-yellow"><span className="w-2 h-2 rounded-full bg-terminal-yellow" />1–7d</span>
          <span className="flex items-center gap-1 text-terminal-red"><span className="w-2 h-2 rounded-full bg-terminal-red" />&lt;24h</span>
        </div>
      </div>
      <div className="divide-y divide-terminal-border/50">
        {items.map((item, i) => {
          const c = settlementColor(item.days)
          const pct = Math.max(2, Math.min(100, (item.days / maxDays) * 100))
          return (
            <div key={`${item.marketId || item.mint}-${i}`} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs text-terminal-text truncate flex-1">
                  {item.question}
                </span>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${c.bg} ${c.border} ${c.text} shrink-0`}>
                  {c.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-terminal-card rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${item.days < 1 ? 'bg-terminal-red' : item.days <= 7 ? 'bg-terminal-yellow' : 'bg-terminal-green'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-terminal-muted shrink-0 w-28 text-right">
                  {item.days < 0
                    ? 'Settled'
                    : formatDistanceToNowStrict(new Date(item.closeTime), { addSuffix: true })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PositionsTable({ positions }) {
  if (positions.length === 0) {
    return (
      <div className="bg-terminal-surface border border-terminal-border rounded-lg p-8 text-center">
        <Briefcase size={24} className="mx-auto mb-2 text-terminal-muted" />
        <p className="text-sm text-terminal-muted">No prediction market tokens in wallet</p>
        <p className="text-xs text-terminal-muted mt-1">Place a trade from the Explore tab to build your portfolio</p>
      </div>
    )
  }

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Positions
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-left text-[10px] text-terminal-muted uppercase tracking-wider border-b border-terminal-border/50">
              <th className="px-4 py-2 font-medium">Market</th>
              <th className="px-4 py-2 font-medium">Side</th>
              <th className="px-4 py-2 font-medium text-right">Amount</th>
              <th className="px-4 py-2 font-medium text-right">Current Price</th>
              <th className="px-4 py-2 font-medium text-right">P&amp;L</th>
              <th className="px-4 py-2 font-medium text-right">Settles</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-terminal-border/50">
            {positions.map((p, i) => {
              const c = settlementColor(daysUntil(p.closeTime))
              const isProfit = p.pnl > 0
              const isLoss = p.pnl < 0
              return (
                <tr key={`${p.mint || p.marketId}-${i}`} className="hover:bg-terminal-card/50 transition-colors">
                  <td className="px-4 py-3 max-w-xs">
                    <div className="truncate text-terminal-text">{p.question}</div>
                    {p.eventTitle && <div className="text-[10px] text-terminal-muted truncate">{p.eventTitle}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`flex items-center gap-1 text-[10px] font-bold uppercase ${
                      p.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'
                    }`}>
                      {p.side === 'yes' ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                      {p.side}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-terminal-text">
                    {p.shares.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right text-terminal-text">
                    {(p.currentPrice * 100).toFixed(1)}¢
                  </td>
                  <td className={`px-4 py-3 text-right ${
                    isProfit ? 'text-terminal-green' : isLoss ? 'text-terminal-red' : 'text-terminal-muted'
                  }`}>
                    {isProfit ? '+' : ''}${p.pnl.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.closeTime ? (
                      <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${c.bg} ${c.border} ${c.text}`}>
                        {format(new Date(p.closeTime), 'MMM d')}
                      </span>
                    ) : (
                      <span className="text-terminal-muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Portfolio() {
  const { connected, connect, shortAddress } = useWallet()
  const { positions, totalValue, totalPnl, count, loading, error, source, refresh } = usePortfolio()
  const { orders } = useConditionalOrders()
  const hasOrders = orders.length > 0

  if (!connected) {
    return (
      <div className="bg-terminal-surface border border-terminal-border rounded-lg p-12 text-center">
        <Wallet size={32} className="mx-auto mb-3 text-terminal-muted" />
        <h3 className="text-lg font-semibold text-terminal-text mb-2">Connect your wallet</h3>
        <p className="text-sm text-terminal-muted mb-5">
          Connect Phantom or Solflare to view your prediction market portfolio.
        </p>
        <button
          onClick={connect}
          className="px-5 py-2 bg-terminal-accent hover:bg-terminal-accent/80 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    )
  }

  const pnlPositive = totalPnl > 0
  const pnlNegative = totalPnl < 0

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-terminal-text">Portfolio</h2>
          <p className="text-xs text-terminal-muted font-mono">
            {shortAddress} · {source === 'wallet' ? 'On-chain positions' : 'Local positions (demo)'}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-terminal-card hover:bg-terminal-highlight text-terminal-muted hover:text-terminal-text rounded-lg transition-all disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg px-3 py-2 text-xs text-terminal-yellow">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>Wallet scan failed ({error}). Showing locally-tracked positions.</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          icon={Briefcase}
          label="Positions"
          value={count}
          sub={count > 0 ? `${positions.filter(p => p.side === 'yes').length} YES · ${positions.filter(p => p.side === 'no').length} NO` : null}
        />
        <StatCard
          icon={DollarSign}
          label="Total Value"
          value={`$${totalValue.toFixed(2)}`}
          sub="USDC"
        />
        <StatCard
          icon={pnlNegative ? TrendingDown : TrendingUp}
          label="Total P&L"
          value={`${pnlPositive ? '+' : ''}$${totalPnl.toFixed(2)}`}
          tone={pnlPositive ? 'text-terminal-green' : pnlNegative ? 'text-terminal-red' : 'text-terminal-text'}
          sub={totalValue > 0 ? `${((totalPnl / (totalValue - totalPnl || 1)) * 100).toFixed(2)}%` : null}
        />
      </div>

      {loading && positions.length === 0 ? (
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-12 flex flex-col items-center gap-3">
          <Loader2 size={24} className="text-terminal-accent animate-spin" />
          <p className="text-sm text-terminal-muted">Scanning wallet for prediction market tokens…</p>
        </div>
      ) : (
        <>
          <PositionsTable positions={positions} />
          <SettlementTimeline positions={positions} />
        </>
      )}

      <div>
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-2">
          Active Conditional Orders
        </h3>
        {hasOrders ? (
          <ActiveOrders />
        ) : (
          <div className="bg-terminal-surface border border-terminal-border rounded-lg p-6 text-center">
            <Clock size={20} className="mx-auto mb-2 text-terminal-muted" />
            <p className="text-sm text-terminal-muted">No conditional orders</p>
            <p className="text-xs text-terminal-muted mt-1">Limit, stop-loss, and take-profit orders appear here</p>
          </div>
        )}
      </div>
    </div>
  )
}
