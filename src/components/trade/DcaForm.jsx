import React, { useState } from 'react'
import { AlertCircle, Lock, Wallet, ShieldCheck, Repeat } from 'lucide-react'
import { DCA_FREQUENCIES } from '../../hooks/useDCA'
import { useKyc } from '../../hooks/useKyc'
import DcaProgress from './DcaProgress'

export default function DcaForm({
  market, side, isClosed, mintsMissing, connected, kycVerified,
  usdcBalance, strategies, activeStrategy, onSubmit, onStop,
}) {
  const { setShowModal: openKycModal } = useKyc()
  const [amountPerBuy, setAmountPerBuy] = useState('')
  const [frequency, setFrequency] = useState('4h')
  const [totalBudget, setTotalBudget] = useState('')

  const perBuyNum = parseFloat(amountPerBuy) || 0
  const budgetNum = parseFloat(totalBudget) || 0
  const purchases = perBuyNum > 0 ? Math.floor(budgetNum / perBuyNum) : 0
  const freqLabel = DCA_FREQUENCIES.find(f => f.key === frequency)?.label || frequency
  const insufficientBudget = connected && usdcBalance != null && budgetNum > 0 && budgetNum > usdcBalance

  const past = strategies.filter(s => s.status !== 'active')

  return (
    <div className="space-y-3">
      {!activeStrategy && (
        <>
          <div>
            <label className="text-xs text-terminal-muted mb-1 block">Amount per Purchase (USDC)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
              <input
                type="number"
                value={amountPerBuy}
                onChange={(e) => setAmountPerBuy(e.target.value)}
                placeholder="50.00"
                min="0"
                step="0.01"
                className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-terminal-muted mb-1 block">Frequency</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className="w-full px-3 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
            >
              {DCA_FREQUENCIES.map(f => (
                <option key={f.key} value={f.key}>Every {f.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-terminal-muted mb-1 block">Total Budget (USDC)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
              <input
                type="number"
                value={totalBudget}
                onChange={(e) => setTotalBudget(e.target.value)}
                placeholder="500.00"
                min="0"
                step="0.01"
                className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
              />
            </div>
          </div>

          {perBuyNum > 0 && budgetNum > 0 && (
            <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 text-xs text-terminal-text leading-relaxed">
              Will buy <span className="font-mono font-semibold">${perBuyNum.toFixed(2)}</span>{' '}
              of <span className={`font-semibold ${side === 'yes' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                {side.toUpperCase()}
              </span>{' '}
              every {freqLabel}.<br />
              Total budget: <span className="font-mono font-semibold">${budgetNum.toFixed(2)}</span>.
              Approximately <span className="font-mono font-semibold">{purchases}</span> purchases.
            </div>
          )}

          {insufficientBudget && (
            <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-2.5 text-xs text-terminal-yellow">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Budget exceeds balance</p>
                <p className="text-terminal-yellow/80 mt-0.5 font-mono">
                  You have ${usdcBalance?.toFixed(2)}, DCA budget is ${budgetNum.toFixed(2)}.
                </p>
              </div>
            </div>
          )}

          <button
            onClick={() => {
              if (connected && !kycVerified) {
                openKycModal(true)
                return
              }
              onSubmit({ side, amountPerBuy: perBuyNum, frequency, totalBudget: budgetNum })
              if (!insufficientBudget && !isClosed && !mintsMissing && perBuyNum > 0 && budgetNum > 0 && purchases > 0) {
                setAmountPerBuy('')
                setTotalBudget('')
              }
            }}
            disabled={isClosed || mintsMissing || (connected && kycVerified && (!perBuyNum || !budgetNum || purchases < 1 || insufficientBudget))}
            className="w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-terminal-accent hover:bg-blue-500 text-white shadow-lg shadow-terminal-accent/20 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {isClosed ? (
              <><Lock size={14} /> Trading Closed</>
            ) : !connected ? (
              <><Wallet size={14} /> Connect Wallet to Start DCA</>
            ) : !kycVerified ? (
              <><ShieldCheck size={14} /> Verify Identity to Start DCA</>
            ) : insufficientBudget ? (
              <><AlertCircle size={14} /> Insufficient USDC</>
            ) : (
              <><Repeat size={14} /> Start DCA</>
            )}
          </button>
        </>
      )}

      {activeStrategy && (
        <DcaProgress strategy={activeStrategy} onStop={() => onStop(activeStrategy.id)} />
      )}

      {past.length > 0 && !activeStrategy && (
        <div className="space-y-2">
          <p className="text-[10px] text-terminal-muted uppercase tracking-wider">Past strategies</p>
          {past.slice(-3).map(s => (
            <DcaProgress key={s.id} strategy={s} compact />
          ))}
        </div>
      )}
    </div>
  )
}
