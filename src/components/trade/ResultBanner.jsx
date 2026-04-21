import React from 'react'
import { Check, AlertCircle } from 'lucide-react'
import { DCA_FREQUENCIES } from '../../hooks/useDCA'

export default function ResultBanner({ result }) {
  if (!result) return null

  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
      result.success
        ? 'bg-terminal-green/10 border border-terminal-green/30 text-terminal-green'
        : 'bg-terminal-red/10 border border-terminal-red/30 text-terminal-red'
    }`}>
      {result.success ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
      <div>
        <p className="font-medium">
          {result.success
            ? result.dca ? 'DCA Strategy Started!'
              : result.conditional ? 'Conditional Order Placed!' : 'Order Filled!'
            : 'Order Failed'}
        </p>
        {result.success && result.dca && (
          <p className="text-terminal-muted mt-0.5">
            Buying ${result.strategy.amountPerBuy.toFixed(2)} of {result.strategy.side.toUpperCase()} every{' '}
            {DCA_FREQUENCIES.find(f => f.key === result.strategy.frequency)?.label}.
          </p>
        )}
        {result.success && result.conditional && (
          <p className="text-terminal-muted mt-0.5">
            {result.order.orderType} order set at {(result.order.triggerPrice * 100).toFixed(1)}¢ for ${result.order.amount.toFixed(2)}
          </p>
        )}
        {result.success && !result.conditional && !result.dca && result.order && (
          <p className="text-terminal-muted mt-0.5">
            {result.order.shares} shares @ {(result.order.price * 100).toFixed(1)}¢ = ${result.order.amount.toFixed(2)}
            {result.order.txSigned && ' (tx signed)'}
          </p>
        )}
        {!result.success && result.error && (
          <p className="text-terminal-muted mt-0.5">{result.error}</p>
        )}
      </div>
    </div>
  )
}
