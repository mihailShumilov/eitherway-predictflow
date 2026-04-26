import React from 'react'
import { Clock, X, Trash2, Loader2, Check, AlertTriangle, Target, TrendingDown, TrendingUp } from 'lucide-react'
import { useConditionalOrders } from '../hooks/useConditionalOrders'

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
  executing: { label: 'Executing', icon: Loader2, color: 'text-terminal-accent', spin: true },
  filled: { label: 'Filled', icon: Check, color: 'text-terminal-green' },
  failed: { label: 'Failed', icon: AlertTriangle, color: 'text-terminal-red' },
  cancelled: { label: 'Cancelled', icon: X, color: 'text-terminal-muted' },
}

export default function ActiveOrders({ marketId }) {
  const { orders, cancelOrder, cancelAll, clearCompleted } = useConditionalOrders()

  const relevantOrders = marketId
    ? orders.filter(o => o.marketId === marketId)
    : orders

  const pendingCount = relevantOrders.filter(o => o.status === 'pending').length
  const completedCount = relevantOrders.filter(o => o.status !== 'pending' && o.status !== 'executing').length

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
                  <span className={`text-[10px] font-bold uppercase ${
                    order.side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'
                  }`}>
                    {order.side}
                  </span>
                  <span className="text-xs text-terminal-text font-mono truncate">
                    {order.question?.slice(0, 40)}{order.question?.length > 40 ? '...' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`flex items-center gap-1 text-[10px] ${statusConf.color}`}>
                    <StatusIcon size={10} className={statusConf.spin ? 'animate-spin' : ''} />
                    {statusConf.label}
                  </span>
                  {order.status === 'pending' && (
                    <button
                      onClick={() => cancelOrder(order.id)}
                      className="p-1 rounded hover:bg-terminal-red/10 text-terminal-muted hover:text-terminal-red transition-all"
                      title="Cancel order"
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
