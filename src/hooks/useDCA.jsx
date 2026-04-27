import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react'
import { useWallet } from './useWallet'
import { DFLOW_ORDER_URL, USDC_MINT, ALLOW_SYNTHESIZED_MINTS, ALLOW_SIMULATED_FILLS } from '../config/env'
import { reportError } from '../lib/errorReporter'
import { track } from '../lib/analytics'
import { safeGet, safeSet, appendPosition } from '../lib/storage'
import { runOrderPipeline } from '../lib/orderTxPipeline'

const DCAContext = createContext(null)

const STORAGE_KEY = 'predictflow_dca_strategies'
const TICK_INTERVAL = 30000

export const DCA_FREQUENCIES = [
  { key: '1h', label: '1 hour', ms: 3600000 },
  { key: '4h', label: '4 hours', ms: 4 * 3600000 },
  { key: '12h', label: '12 hours', ms: 12 * 3600000 },
  { key: '24h', label: '24 hours', ms: 24 * 3600000 },
]

function freqMs(key) {
  return DCA_FREQUENCIES.find(f => f.key === key)?.ms ?? 3600000
}

function load() {
  const v = safeGet(STORAGE_KEY, [])
  return Array.isArray(v) ? v : []
}

function save(strategies) {
  safeSet(STORAGE_KEY, strategies)
}

function generateId() {
  return `dca-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function totalPurchasesFor(budget, perBuy) {
  if (!perBuy || perBuy <= 0) return 0
  return Math.floor(budget / perBuy)
}

// Try real DFlow order + wallet sign. Returns null if the order couldn't be
// signed and simulated fills are disabled (prod default). Otherwise returns
// an execution record. Never silently fakes money in prod.
async function submitDcaBuy({ strategy, address, provider, currentPrice }) {
  const realMint = strategy.side === 'yes' ? strategy.yesMint : strategy.noMint
  const outputMint = realMint || (ALLOW_SYNTHESIZED_MINTS
    ? (strategy.side === 'yes' ? `YES-${strategy.marketId}-mint` : `NO-${strategy.marketId}-mint`)
    : null)

  if (!outputMint) {
    const err = new Error('DCA buy skipped: no outcome mint for this market')
    reportError(err, { strategyId: strategy.id, marketId: strategy.marketId })
    return null
  }

  const amountLamports = Math.floor(strategy.amountPerBuy * 1e6)

  let txSigned = false
  let txSignature = null
  // DCA goes through the shared pipeline now — same validate → decode →
  // whitelist → preflight → signAndSend sequence as market trades. The
  // legacy impl skipped preflight; standardizing here is fine because
  // an invalid DCA buy should fail loudly, not silently retry.
  const result = await runOrderPipeline({
    inputMint: USDC_MINT,
    outputMint,
    amountLamports,
    userPublicKey: address,
    idempotencyPrefix: 'dca',
    provider,
    preflight: true,
    broadcast: 'send',
  })
  if (result.ok) {
    txSigned = true
    txSignature = result.signature
  } else {
    reportError(new Error(result.error), { context: 'submitDcaBuy', strategyId: strategy.id })
  }

  if (!txSigned && !ALLOW_SIMULATED_FILLS) {
    // Prod: don't record a fake execution. Caller leaves nextRunAt alone so
    // the strategy will retry on the next tick.
    return null
  }

  const price = currentPrice ?? 0.5
  const shares = strategy.amountPerBuy / price

  track('dca_execution', {
    strategyId: strategy.id,
    simulated: !txSigned,
    amount: strategy.amountPerBuy,
  })

  return {
    id: `dca-fill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    amount: strategy.amountPerBuy,
    price,
    shares: parseFloat(shares.toFixed(4)),
    txSigned,
    txSignature: txSignature || (txSigned ? 'signed' : 'simulated'),
  }
}

export function DCAProvider({ children }) {
  const [strategies, setStrategies] = useState(load)
  const { activeWallet, address } = useWallet()
  const firingRef = useRef(new Set())
  const strategiesRef = useRef(strategies)

  useEffect(() => {
    strategiesRef.current = strategies
    save(strategies)
  }, [strategies])

  const patchStrategy = useCallback((id, patch) => {
    setStrategies(prev => prev.map(s => s.id === id ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s))
  }, [])

  const startStrategy = useCallback((config) => {
    const now = Date.now()
    const strategy = {
      id: generateId(),
      marketId: config.marketId,
      marketTicker: config.marketTicker || null,
      eventTicker: config.eventTicker || null,
      yesMint: config.yesMint || null,
      noMint: config.noMint || null,
      question: config.question,
      eventTitle: config.eventTitle,
      category: config.category,
      closeTime: config.closeTime || null,
      side: config.side,
      amountPerBuy: config.amountPerBuy,
      frequency: config.frequency,
      totalBudget: config.totalBudget,
      totalPurchases: totalPurchasesFor(config.totalBudget, config.amountPerBuy),
      referencePrice: config.referencePrice ?? 0.5,
      status: 'active',
      startedAt: new Date(now).toISOString(),
      nextRunAt: new Date(now).toISOString(),
      executions: [],
    }
    setStrategies(prev => [...prev, strategy])
    return strategy
  }, [])

  const stopStrategy = useCallback((id) => {
    patchStrategy(id, { status: 'cancelled', nextRunAt: null })
  }, [patchStrategy])

  const removeStrategy = useCallback((id) => {
    setStrategies(prev => prev.filter(s => s.id !== id))
  }, [])

  // Persist a completed DCA purchase into the positions ledger so it shows
  // up in Positions + Portfolio alongside other trades. Write is serialized
  // through appendPosition() so concurrent manual/conditional/DCA writes
  // don't clobber each other.
  const recordPosition = useCallback((strategy, execution) => {
    return appendPosition({
      id: `ord-${execution.id}`,
      marketId: strategy.marketId,
      side: strategy.side,
      type: 'dca',
      amount: execution.amount,
      price: execution.price,
      shares: execution.shares,
      timestamp: execution.timestamp,
      status: 'filled',
      txSigned: execution.txSigned,
      question: strategy.question,
      eventTitle: strategy.eventTitle,
      category: strategy.category,
      closeTime: strategy.closeTime || null,
      dcaStrategyId: strategy.id,
    })
  }, [])

  const runStrategy = useCallback(async (strategy) => {
    if (firingRef.current.has(strategy.id)) return
    firingRef.current.add(strategy.id)
    try {
      const provider = activeWallet?.getProvider?.() || null
      const execution = await submitDcaBuy({
        strategy,
        address,
        provider,
        currentPrice: strategy.referencePrice,
      })

      if (!execution) {
        // No fill this tick — leave strategy as-is so the next tick retries.
        return
      }

      await recordPosition(strategy, execution)

      setStrategies(prev => prev.map(s => {
        if (s.id !== strategy.id) return s
        const executions = [...s.executions, execution]
        const spent = executions.reduce((sum, e) => sum + e.amount, 0)
        const reachedBudget = spent + s.amountPerBuy > s.totalBudget + 0.0001
        const reachedCount = executions.length >= s.totalPurchases
        const done = reachedBudget || reachedCount
        return {
          ...s,
          executions,
          nextRunAt: done ? null : new Date(Date.now() + freqMs(s.frequency)).toISOString(),
          status: done ? 'completed' : 'active',
          completedAt: done ? new Date().toISOString() : null,
        }
      }))
    } finally {
      firingRef.current.delete(strategy.id)
    }
  }, [activeWallet, address, recordPosition])

  const hasActive = strategies.some(s => s.status === 'active')
  useEffect(() => {
    if (!hasActive) return
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const now = Date.now()
      for (const s of strategiesRef.current) {
        if (s.status !== 'active') continue
        if (!s.nextRunAt) continue
        if (new Date(s.nextRunAt).getTime() <= now) {
          runStrategy(s)
        }
      }
    }
    tick()
    const interval = setInterval(tick, TICK_INTERVAL)
    return () => { cancelled = true; clearInterval(interval) }
  }, [hasActive, runStrategy])

  const activeStrategies = useMemo(
    () => strategies.filter(s => s.status === 'active'),
    [strategies]
  )
  const strategiesForMarket = useCallback((marketId) => {
    return strategies.filter(s => s.marketId === marketId)
  }, [strategies])

  return (
    <DCAContext.Provider value={{
      strategies,
      activeStrategies,
      strategiesForMarket,
      startStrategy,
      stopStrategy,
      removeStrategy,
    }}>
      {children}
    </DCAContext.Provider>
  )
}

export function useDCA() {
  const ctx = useContext(DCAContext)
  if (!ctx) throw new Error('useDCA must be used within DCAProvider')
  return ctx
}
