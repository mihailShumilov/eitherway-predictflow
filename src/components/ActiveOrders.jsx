import React, { useMemo, useState } from 'react'
import { Clock, X, Trash2, Loader2, Check, AlertTriangle, Target, TrendingDown, TrendingUp, Cloud, Shield } from 'lucide-react'
import { useConditionalOrders } from '../hooks/useConditionalOrders'
import { useKeeperOrders } from '../hooks/useKeeperOrders'
import { useKeeperApprovalOrder } from '../hooks/useKeeperApprovalOrder'

function formatDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const TYPE_CONFIG = {
  limit: { label: 'Limit', icon: Target, color: 'text-terminal-accent', bg: 'bg-terminal-accent/10', border: 'border-terminal-accent/30' },
  'stop-loss': { label: 'Stop-Loss', icon: TrendingDown, color: 'text-terminal-red', bg: 'bg-terminal-red/10', border: 'border-terminal-red/30' },
  'take-profit': { label: 'Take-Profit', icon: TrendingUp, color: 'text-terminal-green', bg: 'bg-terminal-green/10', border: 'border-terminal-green/30' },
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', icon: Clock, color: 'text-terminal-yellow' },
  armed: { label: 'Armed', icon: Loader2, color: 'text-terminal-accent', spin: true },
  submitting: { label: 'Submitting', icon: Loader2, color: 'text-terminal-accent', spin: true },
  executing: { label: 'Executing', icon: Loader2, color: 'text-terminal-accent', spin: true },
  filled: { label: 'Filled', icon: Check, color: 'text-terminal-green' },
  failed: { label: 'Failed', icon: AlertTriangle, color: 'text-terminal-red' },
  expired: { label: 'Expired', icon: AlertTriangle, color: 'text-terminal-muted' },
  cancelled: { label: 'Cancelled', icon: X, color: 'text-terminal-muted' },
}

export default function ActiveOrders({ marketId, marketTicker }) {
  const { orders: localOrders, cancelOrder: cancelLocal, cancelAll: cancelAllLocal, clearCompleted: clearLocalCompleted } = useConditionalOrders()
  const { orders: keeperOrders, cancelOrder: cancelKeeper, clearOrders: clearKeeper } = useKeeperOrders()
  const { revokeApproval } = useKeeperApprovalOrder()
  const [revoking, setRevoking] = useState(false)
  const [revokeMsg, setRevokeMsg] = useState(null)

  // Tag orders with their backing source so cancelOrder routes to the right
  // store and the row can show a "cloud" badge for keeper-backed orders.
  const allOrders = useMemo(() => {
    const local = localOrders.map(o => ({ ...o, source: o.source || 'local' }))
    return [...keeperOrders, ...local]
  }, [localOrders, keeperOrders])

  // Filter to this market — both id and ticker are matched because keeper
  // and local orders identify markets differently.
  const relevantOrders = (marketId || marketTicker)
    ? allOrders.filter(o => (
        (marketId && o.marketId === marketId) ||
        (marketTicker && o.marketTicker === marketTicker)
      ))
    : allOrders

  const pendingCount = relevantOrders.filter(o =>
    o.status === 'pending' || o.status === 'armed' || o.status === 'submitting'
  ).length
  const completedCount = relevantOrders.filter(o =>
    !['pending', 'armed', 'submitting', 'executing'].includes(o.status)
  ).length

  const cancelOrder = (id) => {
    const order = allOrders.find(o => o.id === id)
    if (!order) return
    if (order.source === 'keeper') return cancelKeeper(id)
    return cancelLocal(id)
  }

  // "Cancel All" must dispatch to BOTH backends — the legacy localStorage
  // path (cancelAllLocal) and the keeper API (per-order cancel since the
  // API doesn't expose a bulk endpoint). Without this, keeper orders keep
  // firing after the user clicks Cancel All.
  const cancelAll = async () => {
    const cancellable = relevantOrders.filter(o =>
      o.status === 'pending' || o.status === 'armed' || o.status === 'submitting'
    )
    cancelAllLocal()
    await Promise.allSettled(
      cancellable.filter(o => o.source === 'keeper').map(o => cancelKeeper(o.id)),
    )
  }

  // Clear completed dispatches to BOTH backends so terminal rows
  // (cancelled / failed / expired) disappear from the list — local
  // ones via the legacy hook, keeper-side via the new DELETE /orders
  // endpoint. The keeper call is best-effort; UI still updates from
  // the optimistic state in useKeeperOrders.
  const clearCompleted = async () => {
    clearLocalCompleted()
    await clearKeeper({ marketTicker })
  }

  // Approval-flow rows have an on-chain spl-token delegation rather than a
  // pre-signed tx. Revoke wipes that delegation across every mint the
  // user has active orders against — buys delegate USDC, sells delegate
  // the outcome token. The hook also cancels pending keeper orders for
  // those mints so the keeper doesn't try to fire post-revoke.
  const activeApprovalOrders = relevantOrders.filter((o) =>
    o.flow === 'approval' && (o.status === 'pending' || o.status === 'armed' || o.status === 'submitting')
  )
  const hasApprovalActive = activeApprovalOrders.length > 0
  const onRevoke = async () => {
    if (revoking) return
    setRevoking(true)
    setRevokeMsg(null)
    try {
      const mints = Array.from(new Set(
        activeApprovalOrders.map((o) => o.inputMint).filter(Boolean),
      ))
      const res = await revokeApproval(mints.length > 0 ? { mints } : undefined)
      setRevokeMsg(res?.signature ? 'Approval revoked' : 'Revoke sent')
    } catch (err) {
      setRevokeMsg(err?.message || 'Revoke failed')
    } finally {
      setRevoking(false)
    }
  }

  if (relevantOrders.length === 0) return null

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Active Orders
          </h3>
          {pendingCount > 0 && (
            <span className="text-[10px] font-mono bg-terminal-yellow/10 text-terminal-yellow px-1.5 py-0.5 rounded border border-terminal-yellow/30">
              {pendingCount} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasApprovalActive && (
            <button
              onClick={onRevoke}
              disabled={revoking}
              className="flex items-center gap-1 text-[10px] text-terminal-yellow/80 hover:text-terminal-yellow transition-colors disabled:opacity-50"
              title="Send an spl-token revoke to wipe the keeper's spending delegation. Active orders will fail at fire time after this."
            >
              <Shield size={10} />
              {revoking ? 'Revoking…' : 'Revoke approval'}
            </button>
          )}
          {completedCount > 0 && (
            <button
              onClick={clearCompleted}
              className="text-[10px] text-terminal-muted hover:text-terminal-text transition-colors"
            >
              Clear completed
            </button>
          )}
          {pendingCount > 0 && (
            <button
              onClick={cancelAll}
              className="flex items-center gap-1 text-[10px] text-terminal-red/70 hover:text-terminal-red transition-colors"
            >
              <Trash2 size={10} />
              Cancel All
            </button>
          )}
        </div>
      </div>

      {revokeMsg && (
        <div className="px-4 py-1.5 text-[10px] font-mono text-terminal-muted border-b border-terminal-border">
          {revokeMsg}
        </div>
      )}

      <div className="divide-y divide-terminal-border max-h-64 overflow-y-auto">
        {relevantOrders.map(order => {
          const typeConf = TYPE_CONFIG[order.orderType] || TYPE_CONFIG.limit
          const statusConf = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending
          const TypeIcon = typeConf.icon
          const StatusIcon = statusConf.icon

          return (
            <div key={order.id} className={`px-4 py-3 hover:bg-terminal-card/50 transition-colors ${
              order.status === 'cancelled' ? 'opacity-40' : ''
            }`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`flex items-center gap-1 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${typeConf.bg} ${typeConf.border} border ${typeConf.color}`}>
                    <TypeIcon size={10} />
                    {typeConf.label}
                  </span>
                  {order.source === 'keeper' && (
                    <span
                      className="flex items-center gap-1 text-[10px] font-mono text-terminal-accent"
                      title="Stored on the keeper — fires even when this tab is closed"
                    >
                      <Cloud size={10} />
                      keeper
                    </span>
                  )}
                  {order.flow === 'approval' && (
                    <span
                      className="flex items-center gap-1 text-[10px] font-mono text-terminal-muted"
                      title="Approval-flow order. The keeper holds an spl-token delegation up to your specified amount and signs the swap at fire time."
                    >
                      <Shield size={10} />
                      delegated
                    </span>
                  )}
                  <span className={`text-[10px] font-bold uppercase ${
                    order.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'
                  }`}>
                    {order.side}
                  </span>
                  <span className="text-xs text-terminal-text font-mono truncate">
                    {order.question?.slice(0, 40) || order.marketTicker || order.marketId}{order.question?.length > 40 ? '...' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`flex items-center gap-1 text-[10px] ${statusConf.color}`}>
                    <StatusIcon size={10} className={statusConf.spin ? 'animate-spin' : ''} />
                    {statusConf.label}
                  </span>
                  {(order.status === 'pending' || order.status === 'armed' || order.status === 'submitting') && (
                    <button
                      onClick={() => cancelOrder(order.id)}
                      className="p-1 rounded hover:bg-terminal-red/10 text-terminal-muted hover:text-terminal-red transition-all"
                      title={order.status === 'submitting' ? 'Cancel — broadcast already sent, on-chain outcome may still settle' : 'Cancel order'}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4 mt-1.5 text-[10px] text-terminal-muted font-mono">
                <span>Trigger: <span className="text-terminal-text">{(order.triggerPrice * 100).toFixed(1)}¢</span></span>
                <span>Amount: <span className="text-terminal-text">${order.amount.toFixed(2)}</span></span>
                {order.fillPrice && (
                  <span>Filled: <span className="text-terminal-green">{(order.fillPrice * 100).toFixed(1)}¢</span></span>
                )}
                <span className="ml-auto">{formatDate(order.createdAt)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
