import React, { useState, useMemo, useSyncExternalStore, useEffect } from 'react'
import {
  AlertCircle, Loader2, Eye, ShoppingCart, Target, TrendingDown, TrendingUp,
  Lock, Info, Wallet, ShieldCheck,
} from 'lucide-react'
import { useWallet } from '../hooks/useWallet'
import { useConditionalOrders } from '../hooks/useConditionalOrders'
import { useDCA } from '../hooks/useDCA'
import { useUsdcBalance } from '../hooks/useUsdcBalance'
import { useKyc } from '../hooks/useKyc'
import { useTradeSubmit } from '../hooks/useTradeSubmit'
import { useUserTier } from '../hooks/useUserTier'
import { useUpgradeModal } from '../hooks/useUpgradeModal'
import { canCreateConditionalOrder } from '../services/feeService'
import { ALLOW_SYNTHESIZED_MINTS } from '../config/env'
import { getPositions, subscribePositions, getPositionsVersion } from '../lib/storage'
import TradeStatusBadge from './trade/TradeStatusBadge'
import SideSelector from './trade/SideSelector'
import OrderTypeTabs, { ORDER_TABS } from './trade/OrderTypeTabs'
import DcaForm from './trade/DcaForm'
import ResultBanner from './trade/ResultBanner'
import FeeBreakdown from './monetization/FeeBreakdown'
import UpgradeNudge from './monetization/UpgradeNudge'

function hasPosition(marketId) {
  return getPositions().some(p => p.marketId === marketId && p.status === 'filled')
}

export default function TradePanel({ market }) {
  const { connected, address } = useWallet()
  const { strategiesForMarket, stopStrategy } = useDCA()
  const { pendingOrders } = useConditionalOrders()
  const { balance: usdcBalance } = useUsdcBalance(address)
  const { verified: kycVerified, setShowModal: openKycModal } = useKyc()
  const { tier } = useUserTier()
  const { open: openUpgrade } = useUpgradeModal()
  const trade = useTradeSubmit(market)

  const [side, setSide] = useState(market?.side || 'yes')
  const [orderType, setOrderType] = useState('market')
  const [amount, setAmount] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')

  const dcaStrategies = strategiesForMarket(market.id)
  const activeDca = dcaStrategies.find(s => s.status === 'active')

  const isClosed = new Date(market.closeTime).getTime() <= Date.now()
  const positionsVersion = useSyncExternalStore(subscribePositions, getPositionsVersion, () => 0)
  const hasPos = useMemo(() => hasPosition(market.id), [market.id, positionsVersion])

  const price = side === 'yes' ? market.yesAsk : market.noAsk
  const amountNum = parseFloat(amount) || 0
  const insufficientUsdc = connected && usdcBalance != null && amountNum > 0 && amountNum > usdcBalance
  const hasRealMints = !!(market.yesMint && market.noMint)
  const mintsMissing = !hasRealMints && !ALLOW_SYNTHESIZED_MINTS
  const shares = amount ? (parseFloat(amount) / price).toFixed(2) : '0'
  const potentialPayout = amount ? (parseFloat(amount) / price).toFixed(2) : '0'
  const profit = amount ? ((parseFloat(amount) / price) - parseFloat(amount)).toFixed(2) : '0'

  const visibleTabs = ORDER_TABS.filter(t => {
    if (t.key === 'stop-loss' || t.key === 'take-profit') return hasPos
    return true
  })
  const effectiveOrderType = visibleTabs.find(t => t.key === orderType) ? orderType : 'market'

  // Clear the local amount/trigger inputs once a submission settles so the
  // form resets to a fresh state. Done via effect rather than inline in the
  // submit hook to keep submit logic input-agnostic.
  useEffect(() => {
    if (trade.result?.success && !trade.result?.dca) {
      setAmount('')
      setTriggerPrice('')
    }
  }, [trade.result])

  const handleSide = (next) => {
    setSide(next)
    trade.resetQuote()
    trade.resetResult()
  }
  const handleOrderType = (next) => {
    setOrderType(next)
    trade.resetQuote()
    trade.resetResult()
  }

  const needsCta = !connected || !kycVerified

  const onPrimary = () => {
    if (connected && !kycVerified) {
      openKycModal(true)
      return
    }
    if (effectiveOrderType === 'market') {
      trade.submitMarketTrade({ side, amount })
    } else if (effectiveOrderType === 'dca') {
      // DCA handled in DcaForm
    } else {
      trade.submitConditionalOrder({ orderType: effectiveOrderType, side, amount, triggerPrice })
    }
  }

  const primaryDisabled = trade.submitting
    || isClosed
    || mintsMissing
    || (!needsCta && (!amount || insufficientUsdc))

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">Trade</h3>
        <TradeStatusBadge isClosed={isClosed} connected={connected} kycVerified={kycVerified} />
      </div>

      <div className="p-4 space-y-4">
        {isClosed && (
          <div className="flex items-start gap-2 bg-terminal-muted/10 border border-terminal-muted/30 rounded-lg p-3 text-xs text-terminal-muted">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-terminal-text">Market closed</p>
              <p className="mt-0.5">This market is past its close time. Trading is disabled pending settlement.</p>
            </div>
          </div>
        )}

        {mintsMissing && !isClosed && (
          <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-3 text-xs text-terminal-yellow">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-terminal-text">Market not tradeable</p>
              <p className="mt-0.5 text-terminal-yellow/80">
                DFlow hasn't published outcome mints for this market yet. You can still watch price and depth.
              </p>
            </div>
          </div>
        )}

        {connected && usdcBalance != null && (
          <div className="flex items-center justify-between text-[11px] text-terminal-muted font-mono">
            <span className="flex items-center gap-1" title="Your USDC balance on Solana">
              <Wallet size={10} />
              USDC Balance
            </span>
            <span className="text-terminal-text">${usdcBalance.toFixed(2)}</span>
          </div>
        )}

        <SideSelector side={side} onChange={handleSide} disabled={isClosed} />
        <OrderTypeTabs tabs={visibleTabs} activeKey={effectiveOrderType} onChange={handleOrderType} />

        {effectiveOrderType !== 'market' && effectiveOrderType !== 'dca' && (
          <TriggerPriceInput
            price={price}
            orderType={effectiveOrderType}
            value={triggerPrice}
            onChange={setTriggerPrice}
          />
        )}

        {effectiveOrderType !== 'dca' && (
          <>
            <AmountInput value={amount} onChange={(v) => { setAmount(v); trade.resetQuote(); trade.resetResult() }} />

            {amount && parseFloat(amount) > 0 && (
              <OrderSummary
                effectiveOrderType={effectiveOrderType}
                price={price}
                triggerPrice={triggerPrice}
                amount={amount}
                shares={shares}
                potentialPayout={potentialPayout}
                profit={profit}
              />
            )}

            {trade.quote && trade.quote.error && effectiveOrderType === 'market' && (
              <div className="flex items-start gap-2 bg-terminal-red/10 border border-terminal-red/30 rounded-lg p-2.5 text-xs text-terminal-red">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Quote failed</p>
                  <p className="text-terminal-red/80 mt-0.5">{trade.quote.error}</p>
                </div>
              </div>
            )}

            {trade.quote && !trade.quote.error && effectiveOrderType === 'market' && (
              <>
                <QuoteCard quote={trade.quote} />
                <FeeBreakdown quote={trade.quote} onUpgradeClick={() => openUpgrade('PRO')} />
              </>
            )}

            {effectiveOrderType !== 'market' && effectiveOrderType !== 'dca' && (() => {
              const limit = canCreateConditionalOrder(tier, pendingOrders.length)
              if (limit.allowed) return null
              return (
                <UpgradeNudge
                  tone="yellow"
                  message={limit.reason}
                  ctaLabel={tier === 'FREE' ? 'Upgrade to Pro' : 'Upgrade to Whale'}
                  onClick={() => openUpgrade(tier === 'FREE' ? 'PRO' : 'WHALE')}
                />
              )
            })()}

            {insufficientUsdc && (
              <div className="flex items-start gap-2 bg-terminal-yellow/10 border border-terminal-yellow/30 rounded-lg p-2.5 text-xs text-terminal-yellow">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Insufficient USDC</p>
                  <p className="text-terminal-yellow/80 mt-0.5 font-mono">
                    You have ${usdcBalance?.toFixed(2)}, need ${amountNum.toFixed(2)}.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {effectiveOrderType === 'market' && amount && parseFloat(amount) > 0 && !trade.quote && connected && (
                <button
                  onClick={() => trade.previewQuote({ side, amount })}
                  disabled={trade.previewing}
                  className="w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 bg-terminal-card border border-terminal-border text-terminal-text hover:border-terminal-accent hover:text-terminal-accent disabled:opacity-50"
                >
                  {trade.previewing
                    ? (<><Loader2 size={14} className="animate-spin" /> Fetching Quote...</>)
                    : (<><Eye size={14} /> Preview Order</>)}
                </button>
              )}

              <PrimarySubmitButton
                effectiveOrderType={effectiveOrderType}
                side={side}
                amount={amount}
                submitting={trade.submitting}
                isClosed={isClosed}
                connected={connected}
                kycVerified={kycVerified}
                insufficientUsdc={insufficientUsdc}
                disabled={primaryDisabled}
                onClick={onPrimary}
              />
            </div>
          </>
        )}

        {effectiveOrderType === 'dca' && (
          <DcaForm
            market={market}
            side={side}
            isClosed={isClosed}
            mintsMissing={mintsMissing}
            connected={connected}
            kycVerified={kycVerified}
            usdcBalance={usdcBalance}
            strategies={dcaStrategies}
            activeStrategy={activeDca}
            onSubmit={trade.submitDca}
            onStop={stopStrategy}
          />
        )}

        <ResultBanner result={trade.result} />
      </div>
    </div>
  )
}

function TriggerPriceInput({ price, orderType, value, onChange }) {
  const sliderPct = value || Math.round(price * 100)
  return (
    <div>
      <label className="text-xs text-terminal-muted mb-1 flex items-center justify-between">
        <span>
          {orderType === 'limit' ? 'Limit Price' : orderType === 'stop-loss' ? 'Stop Trigger Price' : 'Take-Profit Target'} (¢)
        </span>
        <span className="text-[10px] font-mono text-terminal-muted">
          Current: {(price * 100).toFixed(1)}¢
        </span>
      </label>

      <input
        type="range"
        min="1"
        max="99"
        step="1"
        value={sliderPct}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer mb-2"
        style={{
          background: `linear-gradient(to right, rgb(var(--terminal-green)) 0%, rgb(var(--terminal-accent)) ${sliderPct}%, rgb(var(--terminal-border)) ${sliderPct}%)`,
        }}
      />

      <div className="relative">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`${(price * 100).toFixed(0)}`}
          min="1"
          max="99"
          step="1"
          className="w-full px-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-terminal-muted text-xs">¢</span>
      </div>

      {orderType === 'stop-loss' && value && parseFloat(value) >= price * 100 && (
        <p className="text-[10px] text-terminal-red mt-1">Must be below current price ({(price * 100).toFixed(1)}¢)</p>
      )}
      {orderType === 'take-profit' && value && parseFloat(value) <= price * 100 && (
        <p className="text-[10px] text-terminal-red mt-1">Must be above current price ({(price * 100).toFixed(1)}¢)</p>
      )}
    </div>
  )
}

function AmountInput({ value, onChange }) {
  return (
    <div>
      <label className="text-xs text-terminal-muted mb-1 block">Amount (USDC)</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted text-sm">$</span>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          min="0"
          step="0.01"
          className="w-full pl-7 pr-4 py-2.5 bg-terminal-card border border-terminal-border rounded-lg text-sm font-mono text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30"
        />
      </div>
      <div className="flex gap-2 mt-2">
        {[10, 25, 50, 100].map(preset => (
          <button
            key={preset}
            onClick={() => onChange(preset.toString())}
            className="flex-1 py-1 text-xs font-mono bg-terminal-card border border-terminal-border rounded hover:border-terminal-accent/50 text-terminal-muted hover:text-terminal-text transition-all"
          >
            ${preset}
          </button>
        ))}
      </div>
    </div>
  )
}

function OrderSummary({ effectiveOrderType, price, triggerPrice, amount, shares, potentialPayout, profit }) {
  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-3 space-y-2">
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted flex items-center gap-1" title={effectiveOrderType === 'market' ? 'Market price your order will fill at' : 'Price that will trigger this conditional order'}>
          {effectiveOrderType === 'market' ? 'Price' : 'Trigger Price'}
          <Info size={10} className="text-terminal-muted/60" />
        </span>
        <span className="font-mono text-terminal-text">
          {effectiveOrderType === 'market'
            ? `${(price * 100).toFixed(1)}¢`
            : triggerPrice ? `${parseFloat(triggerPrice).toFixed(1)}¢` : '—'}
        </span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted flex items-center gap-1" title="Shares you'll receive — each pays $1.00 if the market resolves in your favor">
          Est. Shares
          <Info size={10} className="text-terminal-muted/60" />
        </span>
        <span className="font-mono text-terminal-text">
          {effectiveOrderType !== 'market' && triggerPrice
            ? (parseFloat(amount) / (parseFloat(triggerPrice) / 100)).toFixed(2)
            : shares}
        </span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted flex items-center gap-1" title="Maximum USDC you'll receive if the market resolves in your favor">
          Potential Payout
          <Info size={10} className="text-terminal-muted/60" />
        </span>
        <span className="font-mono text-terminal-green">${potentialPayout}</span>
      </div>
      {effectiveOrderType !== 'market' && (
        <div className="flex justify-between text-xs border-t border-terminal-border pt-2">
          <span className="text-terminal-muted">Order Type</span>
          <span className={`font-mono font-semibold ${
            effectiveOrderType === 'limit' ? 'text-terminal-accent'
              : effectiveOrderType === 'stop-loss' ? 'text-terminal-red'
              : 'text-terminal-green'
          }`}>
            {effectiveOrderType === 'limit' ? 'Limit'
              : effectiveOrderType === 'stop-loss' ? 'Stop-Loss' : 'Take-Profit'}
          </span>
        </div>
      )}
      {effectiveOrderType === 'market' && (
        <div className="flex justify-between text-xs border-t border-terminal-border pt-2">
          <span className="text-terminal-muted">Potential Profit</span>
          <span className={`font-mono font-bold ${parseFloat(profit) > 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {parseFloat(profit) > 0 ? '+' : ''}${profit}
          </span>
        </div>
      )}
    </div>
  )
}

function QuoteCard({ quote }) {
  return (
    <div className="bg-terminal-accent/5 border border-terminal-accent/20 rounded-lg p-3 space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-terminal-accent font-semibold">Quote Preview</span>
        <span className="text-[10px] text-terminal-muted font-mono">{quote.source}</span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted">Output</span>
        <span className="font-mono text-terminal-text">{quote.outputAmount} shares</span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted flex items-center gap-1" title="How much your trade moves the market price. Lower is better.">
          Price Impact
          <Info size={10} className="text-terminal-muted/60" />
        </span>
        <span className={`font-mono ${parseFloat(quote.priceImpact) > 1 ? 'text-terminal-yellow' : 'text-terminal-green'}`}>
          {quote.priceImpact}%
        </span>
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-terminal-muted flex items-center gap-1" title="Protocol fee for this trade">
          Fee
          <Info size={10} className="text-terminal-muted/60" />
        </span>
        <span className="font-mono text-terminal-text">${quote.fee}</span>
      </div>
    </div>
  )
}

function PrimarySubmitButton({
  effectiveOrderType, side, amount, submitting,
  isClosed, connected, kycVerified, insufficientUsdc, disabled, onClick,
}) {
  const colorClasses = effectiveOrderType === 'market'
    ? side === 'yes'
      ? 'bg-terminal-green hover:bg-emerald-500 text-white shadow-lg shadow-terminal-green/20'
      : 'bg-terminal-red hover:bg-red-500 text-white shadow-lg shadow-terminal-red/20'
    : effectiveOrderType === 'limit'
      ? 'bg-terminal-accent hover:bg-blue-500 text-white shadow-lg shadow-terminal-accent/20'
      : effectiveOrderType === 'stop-loss'
        ? 'bg-terminal-red hover:bg-red-500 text-white shadow-lg shadow-terminal-red/20'
        : 'bg-terminal-green hover:bg-emerald-500 text-white shadow-lg shadow-terminal-green/20'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-3 min-h-[44px] rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 active:scale-[0.99] ${colorClasses} disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100`}
    >
      {submitting ? (
        <><Loader2 size={16} className="animate-spin" />{connected ? 'Signing & Submitting...' : 'Placing Order...'}</>
      ) : isClosed ? (
        <><Lock size={14} /> Trading Closed</>
      ) : !connected ? (
        <><Wallet size={14} /> Connect Wallet to Trade</>
      ) : !kycVerified ? (
        <><ShieldCheck size={14} /> Verify Identity to Trade</>
      ) : insufficientUsdc ? (
        <><AlertCircle size={14} /> Insufficient USDC</>
      ) : effectiveOrderType === 'market' ? (
        <><ShoppingCart size={14} />{`Buy ${side.toUpperCase()} — ${amount ? `$${amount}` : 'Enter Amount'}`}</>
      ) : (
        <>
          {effectiveOrderType === 'limit' && <Target size={14} />}
          {effectiveOrderType === 'stop-loss' && <TrendingDown size={14} />}
          {effectiveOrderType === 'take-profit' && <TrendingUp size={14} />}
          {`Place ${effectiveOrderType === 'limit' ? 'Limit' : effectiveOrderType === 'stop-loss' ? 'Stop-Loss' : 'Take-Profit'} Order`}
        </>
      )}
    </button>
  )
}
