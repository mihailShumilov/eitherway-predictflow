import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react'

const OrdersContext = createContext(null)

const STORAGE_KEY = 'predictflow_conditional_orders'
const POLL_INTERVAL = 5000

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

// Simulated live price fetcher. In production this would hit
// GET /api/v1/live_data/by-event/{event_ticker} via DFlow.
async function fetchLivePrice(marketId, currentYesAsk) {
  // Simulate minor price fluctuation around the market's current price
  const drift = (Math.random() - 0.5) * 0.04
  const price = Math.min(0.99, Math.max(0.01, currentYesAsk + drift))
  return { yes: price, no: 1 - price }
}

export function OrdersProvider({ children }) {
  const [orders, setOrders] = useState(loadOrders)
  const [notifications, setNotifications] = useState([])
  const priceCache = useRef({})

  // Persist whenever orders change
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

  // Execute an order (simulate DFlow /order call)
  const executeOrder = useCallback(async (order, livePrice) => {
    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'executing' } : o
    ))

    // Simulate signing and execution delay
    await new Promise(r => setTimeout(r, 1200))

    const fillPrice = order.side === 'yes' ? livePrice.yes : livePrice.no
    const shares = order.amount / fillPrice

    // Save to positions
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
      txSigned: false,
      question: order.question,
      eventTitle: order.eventTitle,
      category: order.category,
    })
    localStorage.setItem('predictflow_positions', JSON.stringify(positions))

    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'filled', filledAt: new Date().toISOString(), fillPrice } : o
    ))

    const typeLabel = order.orderType === 'limit' ? 'Limit order' :
      order.orderType === 'stop-loss' ? 'Stop-loss' : 'Take-profit'
    addNotification(`${typeLabel} triggered! ${order.side.toUpperCase()} ${shares.toFixed(2)} shares @ ${(fillPrice * 100).toFixed(1)}¢`)
  }, [addNotification])

  // Price monitor — polls every 5 seconds for pending orders
  useEffect(() => {
    const interval = setInterval(async () => {
      const pending = orders.filter(o => o.status === 'pending')
      if (pending.length === 0) return

      // Group by market to avoid duplicate fetches
      const byMarket = {}
      for (const o of pending) {
        if (!byMarket[o.marketId]) byMarket[o.marketId] = []
        byMarket[o.marketId].push(o)
      }

      for (const [marketId, marketOrders] of Object.entries(byMarket)) {
        const basePrice = marketOrders[0].currentPrice || 0.5
        const livePrice = await fetchLivePrice(marketId, basePrice)
        priceCache.current[marketId] = livePrice

        for (const order of marketOrders) {
          const currentSidePrice = order.side === 'yes' ? livePrice.yes : livePrice.no
          let shouldExecute = false

          if (order.orderType === 'limit') {
            // Limit buy: execute when price drops to or below target
            shouldExecute = currentSidePrice <= order.triggerPrice
          } else if (order.orderType === 'stop-loss') {
            // Stop-loss: execute when price drops to or below trigger
            shouldExecute = currentSidePrice <= order.triggerPrice
          } else if (order.orderType === 'take-profit') {
            // Take-profit: execute when price rises to or above target
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
