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
        {!result.success && result.details && (
          <p className="text-terminal-muted/80 mt-1 text-[11px] font-mono break-all">
            {result.details}
          </p>
        )}
        {!result.success && Array.isArray(result.logs) && result.logs.length > 0 && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-terminal-muted/80 text-[11px] hover:text-terminal-muted">
              Show simulation logs ({result.logs.length})
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] font-mono text-terminal-muted/70 bg-terminal-red/5 border border-terminal-red/20 rounded p-2">
              {result.logs.join('\n')}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
