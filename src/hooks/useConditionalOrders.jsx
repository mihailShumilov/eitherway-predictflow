import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'
import { useWallet } from './useWallet'

const OrdersContext = createContext(null)

const STORAGE_KEY = 'predictflow_conditional_orders'
const POLL_INTERVAL = 5000
const DFLOW_BASE = '/api/dflow'
const DFLOW_ORDER_URL = 'https://dev-quote-api.dflow.net/order'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function loadOrders() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveOrders(orders) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders))
  } catch {
    // storage full
  }
}

function generateId() {
  return `cond-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// DFlow live_data payload shape isn't formally documented — probe a few common layouts.
function parseLivePrice(payload, marketId) {
  if (!payload) return null
  const candidates = [payload]
  if (Array.isArray(payload)) candidates.push(...payload)
  if (Array.isArray(payload.markets)) candidates.push(...payload.markets)
  if (Array.isArray(payload.data)) candidates.push(...payload.data)

  const pickYes = (c) => {
    const yes = parseFloat(c.yesAsk ?? c.yes_ask ?? c.yesPrice ?? c.yes_price ?? c.yes)
    return Number.isFinite(yes) ? yes : null
  }

  if (marketId) {
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue
      const id = c.id ?? c.marketId ?? c.market_id ?? c.ticker ?? c.marketTicker
      if (id === marketId) {
        const yes = pickYes(c)
        if (yes !== null) return { yes, no: 1 - yes }
      }
    }
  }
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const yes = pickYes(c)
    if (yes !== null) return { yes, no: 1 - yes }
  }
  return null
}

async function fetchLivePrice(order) {
  if (order.eventTicker) {
    try {
      const res = await fetch(`${DFLOW_BASE}/api/v1/live_data/by-event/${encodeURIComponent(order.eventTicker)}`)
      if (res.ok) {
        const data = await res.json()
        const parsed = parseLivePrice(data, order.marketId)
        if (parsed) return { ...parsed, source: 'dflow' }
      }
    } catch {
      // fall through to simulated drift
    }
  }
  const base = order.currentPrice ?? 0.5
  const drift = (Math.random() - 0.5) * 0.04
  const price = Math.min(0.99, Math.max(0.01, base + drift))
  return { yes: price, no: 1 - price, source: 'simulated' }
}

export function OrdersProvider({ children }) {
  const [orders, setOrders] = useState(loadOrders)
  const [notifications, setNotifications] = useState([])
  const priceCache = useRef({})
  const { activeWallet, address } = useWallet()

  useEffect(() => {
    saveOrders(orders)
  }, [orders])

  const addOrder = useCallback((order) => {
    const newOrder = {
      id: generateId(),
      ...order,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    setOrders(prev => [...prev, newOrder])
    return newOrder
  }, [])

  const cancelOrder = useCallback((orderId) => {
    setOrders(prev => prev.map(o =>
      o.id === orderId ? { ...o, status: 'cancelled' } : o
    ))
  }, [])

  const cancelAll = useCallback(() => {
    setOrders(prev => prev.map(o =>
      o.status === 'pending' ? { ...o, status: 'cancelled' } : o
    ))
  }, [])

  const clearCompleted = useCallback(() => {
    setOrders(prev => prev.filter(o => o.status === 'pending'))
  }, [])

  const addNotification = useCallback((msg) => {
    const id = Date.now()
    setNotifications(prev => [...prev, { id, message: msg }])
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id))
    }, 6000)
  }, [])

  const dismissNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  // Attempt real DFlow /order + wallet sign. Returns true on successful signature.
  const submitToDflow = useCallback(async (order) => {
    if (!address) return false
    const outputMint = order.side === 'yes' ? order.yesMint : order.noMint
    if (!outputMint) return false
    try {
      const amountLamports = Math.floor(order.amount * 1e6)
      const url = `${DFLOW_ORDER_URL}?inputMint=${USDC_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountLamports}&userPublicKey=${address}`
      const res = await fetch(url)
      if (!res.ok) return false
      const data = await res.json()
      const provider = activeWallet?.getProvider?.()
      if (!provider || !data.transaction) return false
      const tx = typeof data.transaction === 'string'
        ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
        : data.transaction
      await provider.signTransaction(tx)
      return true
    } catch {
      return false
    }
  }, [activeWallet, address])

  const executeOrder = useCallback(async (order, livePrice) => {
    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'executing' } : o
    ))

    const txSigned = await submitToDflow(order)
    if (!txSigned) {
      await new Promise(r => setTimeout(r, 1200))
    }

    const fillPrice = order.side === 'yes' ? livePrice.yes : livePrice.no
    const shares = order.amount / fillPrice

    const positions = JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
    positions.push({
      id: `ord-${Date.now()}`,
      marketId: order.marketId,
      side: order.side,
      type: order.orderType,
      amount: order.amount,
      price: fillPrice,
      shares: parseFloat(shares.toFixed(2)),
      timestamp: new Date().toISOString(),
      status: 'filled',
      txSigned,
      question: order.question,
      eventTitle: order.eventTitle,
      category: order.category,
    })
    localStorage.setItem('predictflow_positions', JSON.stringify(positions))

    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'filled', filledAt: new Date().toISOString(), fillPrice, txSigned } : o
    ))

    const typeLabel = order.orderType === 'limit' ? 'Limit order' :
      order.orderType === 'stop-loss' ? 'Stop-loss' : 'Take-profit'
    const suffix = txSigned ? '' : ' (simulated)'
    addNotification(`${typeLabel} triggered${suffix}! ${order.side.toUpperCase()} ${shares.toFixed(2)} shares @ ${(fillPrice * 100).toFixed(1)}¢`)
  }, [addNotification, submitToDflow])

  useEffect(() => {
    const interval = setInterval(async () => {
      const pending = orders.filter(o => o.status === 'pending')
      if (pending.length === 0) return

      const byMarket = {}
      for (const o of pending) {
        if (!byMarket[o.marketId]) byMarket[o.marketId] = []
        byMarket[o.marketId].push(o)
      }

      for (const [marketId, marketOrders] of Object.entries(byMarket)) {
        const livePrice = await fetchLivePrice(marketOrders[0])
        priceCache.current[marketId] = livePrice

        for (const order of marketOrders) {
          const currentSidePrice = order.side === 'yes' ? livePrice.yes : livePrice.no
          let shouldExecute = false

          if (order.orderType === 'limit') {
            shouldExecute = currentSidePrice <= order.triggerPrice
          } else if (order.orderType === 'stop-loss') {
            shouldExecute = currentSidePrice <= order.triggerPrice
          } else if (order.orderType === 'take-profit') {
            shouldExecute = currentSidePrice >= order.triggerPrice
          }

          if (shouldExecute) {
            executeOrder(order, livePrice)
          }
        }
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [orders, executeOrder])

  const pendingOrders = orders.filter(o => o.status === 'pending')
  const activeOrdersForMarket = useCallback((marketId) => {
    return orders.filter(o => o.marketId === marketId && (o.status === 'pending' || o.status === 'executing'))
  }, [orders])

  return (
    <OrdersContext.Provider value={{
      orders,
      pendingOrders,
      notifications,
      addOrder,
      cancelOrder,
      cancelAll,
      clearCompleted,
      dismissNotification,
      activeOrdersForMarket,
    }}>
      {children}
    </OrdersContext.Provider>
  )
}

export function useConditionalOrders() {
  const ctx = useContext(OrdersContext)
  if (!ctx) throw new Error('useConditionalOrders must be used within OrdersProvider')
  return ctx
}
