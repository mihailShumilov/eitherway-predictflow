import React from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { formatMarketClose, formatMarketCloseFull } from '../lib/dateFormat'
import {
  Wallet, TrendingUp, TrendingDown, DollarSign, Briefcase,
  RefreshCw, Loader2, AlertCircle, ArrowUpRight, ArrowDownRight, Clock,
  Repeat, StopCircle, CheckCircle2, XCircle, MinusCircle, ExternalLink,
} from 'lucide-react'
import { useWallet } from '../hooks/useWallet'
import { usePortfolio } from '../hooks/usePortfolio'
import { useRoute } from '../hooks/useRoute'
import { SOLANA_NETWORK } from '../config/env'

const IS_MAINNET = (SOLANA_NETWORK || '').toLowerCase() === 'mainnet'
const LOCAL_POSITIONS_LABEL = IS_MAINNET ? 'Local positions' : 'Local positions (demo)'
import { useConditionalOrders } from '../hooks/useConditionalOrders'
import { useKeeperOrders } from '../hooks/useKeeperOrders'
import { useDCA, DCA_FREQUENCIES } from '../hooks/useDCA'
import ActiveOrders from './ActiveOrders'
import Skeleton from './Skeleton'
import ReferralSection from './monetization/ReferralSection'

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

function DcaStrategiesSection({ strategies, onStop }) {
  if (strategies.length === 0) return null
  const activeCount = strategies.filter(s => s.status === 'active').length

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center gap-2">
        <Repeat size={12} className="text-terminal-accent" />
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          DCA Strategies
        </h3>
        {activeCount > 0 && (
          <span className="text-[10px] font-mono bg-terminal-accent/10 text-terminal-accent px-1.5 py-0.5 rounded border border-terminal-accent/30">
            {activeCount} active
          </span>
        )}
      </div>
      <div className="divide-y divide-terminal-border/50">
        {strategies.map(s => {
          const completed = s.executions.length
          const total = s.totalPurchases
          const spent = s.executions.reduce((sum, e) => sum + e.amount, 0)
          const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0
          const freqLabel = DCA_FREQUENCIES.find(f => f.key === s.frequency)?.label || s.frequency
          const isActive = s.status === 'active'
          const barClass = s.status === 'cancelled'
            ? 'bg-terminal-muted'
            : s.status === 'completed'
              ? 'bg-terminal-green'
              : 'bg-terminal-accent'
          return (
            <div key={s.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase ${s.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {s.side}
                    </span>
                    <span className="text-xs text-terminal-text truncate">{s.question}</span>
                  </div>
                  {s.eventTitle && (
                    <p className="text-[10px] text-terminal-muted truncate mt-0.5">{s.eventTitle}</p>
                  )}
                </div>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                  isActive
                    ? 'bg-terminal-accent/10 border-terminal-accent/30 text-terminal-accent'
                    : s.status === 'completed'
                      ? 'bg-terminal-green/10 border-terminal-green/30 text-terminal-green'
                      : 'bg-terminal-muted/10 border-terminal-muted/30 text-terminal-muted'
                }`}>
                  {s.status}
                </span>
              </div>

              <div className="text-[10px] text-terminal-muted font-mono">
                {completed} of {total} purchases · ${spent.toFixed(2)} / ${s.totalBudget.toFixed(2)} · ${s.amountPerBuy.toFixed(2)} every {freqLabel}
              </div>

              <div className="h-1.5 bg-terminal-card rounded-full overflow-hidden">
                <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
              </div>

              {isActive && onStop && (
                <div className="flex justify-end">
                  <button
                    onClick={() => onStop(s.id)}
                    className="flex items-center gap-1 text-[10px] text-terminal-red/80 hover:text-terminal-red transition-colors"
                  >
                    <StopCircle size={10} />
                    Stop DCA
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SettlementTimeline({ positions, onOpenMarket }) {
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
          const canOpen = !!(onOpenMarket && item.ticker)
          const handleClick = canOpen ? () => onOpenMarket(item) : undefined
          const handleKey = canOpen
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenMarket(item)
                }
              }
            : undefined
          return (
            <div
              key={`${item.marketId || item.mint}-${i}`}
              onClick={handleClick}
              onKeyDown={handleKey}
              role={canOpen ? 'button' : undefined}
              tabIndex={canOpen ? 0 : undefined}
              title={canOpen ? 'Open market' : undefined}
              aria-label={canOpen ? `Open market: ${item.question}` : undefined}
              className={`px-4 py-3 transition-colors ${
                canOpen
                  ? 'cursor-pointer hover:bg-terminal-card focus:bg-terminal-card focus:outline-none'
                  : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs text-terminal-text truncate flex-1 flex items-center gap-1.5">
                  {item.question}
                  {canOpen && (
                    <ExternalLink size={10} className="text-terminal-muted shrink-0" />
                  )}
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

// Resolved-market badge. `won` is true (user's side won), false (user's
// side lost), or null (settled but outcome undetermined — voided market,
// or DFlow hasn't snapped final prices yet).
function SettlementBadge({ won }) {
  if (won === true) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border bg-terminal-green/10 border-terminal-green/30 text-terminal-green">
        <CheckCircle2 size={10} />
        Won
      </span>
    )
  }
  if (won === false) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border bg-terminal-red/10 border-terminal-red/30 text-terminal-red">
        <XCircle size={10} />
        Lost
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border bg-terminal-muted/10 border-terminal-muted/30 text-terminal-muted">
      <MinusCircle size={10} />
      Settled
    </span>
  )
}

function PositionsTable({ positions, onOpenMarket }) {
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
              <th className="px-4 py-2 font-medium text-right w-10" aria-label="Open"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-terminal-border/50">
            {positions.map((p, i) => {
              const c = settlementColor(daysUntil(p.closeTime))
              const pnlKnown = p.pnl !== null && p.pnl !== undefined
              const isProfit = pnlKnown && p.pnl > 0
              const isLoss = pnlKnown && p.pnl < 0
              const settled = !!p.settled
              const canOpen = !!(onOpenMarket && p.ticker)
              const handleOpen = canOpen ? () => onOpenMarket(p) : undefined
              const handleKey = canOpen
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenMarket(p)
                    }
                  }
                : undefined
              return (
                <tr
                  key={`${p.mint || p.marketId}-${i}`}
                  onClick={handleOpen}
                  onKeyDown={handleKey}
                  role={canOpen ? 'button' : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  title={canOpen ? 'Open market' : undefined}
                  aria-label={canOpen ? `Open market: ${p.question}` : undefined}
                  className={`transition-colors ${
                    canOpen
                      ? 'cursor-pointer hover:bg-terminal-card focus:bg-terminal-card focus:outline-none'
                      : 'hover:bg-terminal-card/50'
                  }`}
                >
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
                    {settled
                      ? (p.won === true ? '$1.00' : p.won === false ? '$0.00' : '—')
                      : `${(p.currentPrice * 100).toFixed(1)}¢`}
                  </td>
                  <td className={`px-4 py-3 text-right ${
                    isProfit ? 'text-terminal-green' : isLoss ? 'text-terminal-red' : 'text-terminal-muted'
                  }`}>
                    {pnlKnown
                      ? `${isProfit ? '+' : ''}$${p.pnl.toFixed(2)}`
                      : (
                        <span title="Entry price unknown — no localStorage record and no on-chain trade history found for this position">—</span>
                      )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {settled ? (
                      <SettlementBadge won={p.won} />
                    ) : p.closeTime ? (() => {
                      const d = new Date(p.closeTime)
                      const includeYear = d.getFullYear() !== new Date().getFullYear()
                      const label = formatMarketClose(p.closeTime, includeYear ? 'MMM d, yyyy HH:mm' : 'MMM d, HH:mm')
                      return (
                        <span
                          className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${c.bg} ${c.border} ${c.text}`}
                          title={formatMarketCloseFull(p.closeTime)}
                        >
                          {label}
                        </span>
                      )
                    })() : (
                      <span className="text-terminal-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canOpen ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenMarket(p) }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-terminal-border bg-terminal-card hover:bg-terminal-highlight hover:border-terminal-accent text-terminal-muted hover:text-terminal-accent text-[10px] font-medium uppercase tracking-wider transition-colors"
                        title="Open market"
                        aria-label={`Open market: ${p.question}`}
                      >
                        Open
                        <ExternalLink size={10} />
                      </button>
                    ) : (
                      <span
                        className="text-terminal-muted/40 text-[10px]"
                        title="Market identifier unavailable for this position"
                      >
                        —
                      </span>
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
  const { orders: keeperOrders } = useKeeperOrders()
  const { strategies: dcaStrategies, stopStrategy } = useDCA()
  const { navigate } = useRoute()
  const handleOpenMarket = (p) => {
    if (!p?.ticker) return
    navigate({ marketTicker: p.ticker, side: p.side, from: 'portfolio' })
  }
  // Either backend may hold orders (keeper for production limit/SL/TP, local
  // for the legacy in-memory fallback). The empty-state gate has to look at
  // both — otherwise a user with only keeper orders sees "No conditional
  // orders" while ActiveOrders would render fine.
  const hasOrders = orders.length > 0 || keeperOrders.length > 0

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
            {shortAddress} · {source === 'wallet' ? 'On-chain positions' : LOCAL_POSITIONS_LABEL}
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
          sub={(() => {
            const costBasis = totalValue - totalPnl
            if (!(costBasis > 0)) return null
            const pct = (totalPnl / costBasis) * 100
            return `${pnlPositive ? '+' : ''}${pct.toFixed(2)}%`
          })()}
        />
      </div>

      {loading && positions.length === 0 ? (
        <div className="space-y-3">
          <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-terminal-border">
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="divide-y divide-terminal-border/50">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="grid grid-cols-6 gap-3 px-4 py-3">
                  <Skeleton className="h-3 w-full col-span-2" />
                  <Skeleton className="h-3 w-10" />
                  <Skeleton className="h-3 w-14 ml-auto" />
                  <Skeleton className="h-3 w-16 ml-auto" />
                  <Skeleton className="h-3 w-12 ml-auto" />
                </div>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-terminal-muted text-center">
            Scanning wallet for prediction market tokens…
          </p>
        </div>
      ) : (
        <>
          <PositionsTable positions={positions} onOpenMarket={handleOpenMarket} />
          <SettlementTimeline positions={positions} onOpenMarket={handleOpenMarket} />
        </>
      )}

      <DcaStrategiesSection strategies={dcaStrategies} onStop={stopStrategy} />

      <ReferralSection />

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
