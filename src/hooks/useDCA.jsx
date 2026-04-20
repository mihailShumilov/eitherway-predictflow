import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'
import { useWallet } from './useWallet'

const DCAContext = createContext(null)

const STORAGE_KEY = 'predictflow_dca_strategies'
const TICK_INTERVAL = 30000
const DFLOW_ORDER_URL = 'https://dev-quote-api.dflow.net/order'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

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
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function save(strategies) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strategies))
  } catch {
    // storage full
  }
}

function generateId() {
  return `dca-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function totalPurchasesFor(budget, perBuy) {
  if (!perBuy || perBuy <= 0) return 0
  return Math.floor(budget / perBuy)
}

// Mirrors TradePanel's market-order flow: try DFlow + wallet-sign, otherwise simulate.
async function submitDcaBuy({ strategy, address, provider, currentPrice }) {
  const outputMint = strategy.side === 'yes'
    ? (strategy.yesMint || `YES-${strategy.marketId}-mint`)
    : (strategy.noMint || `NO-${strategy.marketId}-mint`)
  const amountLamports = Math.floor(strategy.amountPerBuy * 1e6)

  let txSigned = false
  let txSignature = null

  try {
    const url = `${DFLOW_ORDER_URL}?inputMint=${USDC_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountLamports}&userPublicKey=${address}`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      if (provider && data.transaction) {
        const tx = typeof data.transaction === 'string'
          ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
          : data.transaction
        const signed = await provider.signTransaction(tx)
        txSigned = true
        txSignature = signed?.signature
          ? (typeof signed.signature === 'string' ? signed.signature : null)
          : (data.txSignature || null)
      }
    }
  } catch {
    // fall through to simulated fill
  }

  const price = currentPrice ?? 0.5
  const shares = strategy.amountPerBuy / price

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
  // up in Positions + Portfolio alongside other trades.
  const recordPosition = useCallback((strategy, execution) => {
    try {
      const positions = JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
      positions.push({
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
        dcaStrategyId: strategy.id,
      })
      localStorage.setItem('predictflow_positions', JSON.stringify(positions))
    } catch {
      // storage full — skip position record, DCA execution still recorded in strategy
    }
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
      recordPosition(strategy, execution)

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

  useEffect(() => {
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
  }, [runStrategy])

  const activeStrategies = strategies.filter(s => s.status === 'active')
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
