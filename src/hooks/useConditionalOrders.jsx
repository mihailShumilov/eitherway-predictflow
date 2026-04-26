import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react'
import { useWallet } from './useWallet'
import {
  DFLOW_PROXY_BASE as DFLOW_BASE,
  DFLOW_ORDER_URL,
  USDC_MINT,
  LIVE_PRICE_URL,
  ALLOW_SIMULATED_FILLS,
} from '../config/env'
import { fetchWithRetry } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { track } from '../lib/analytics'
import { safeGet, safeSet, appendPosition } from '../lib/storage'
import { shouldTriggerOrder } from '../lib/triggers'

const OrdersContext = createContext(null)

const STORAGE_KEY = 'predictflow_conditional_orders'
const POLL_INTERVAL = 5000

function loadOrders() {
  const v = safeGet(STORAGE_KEY, [])
  return Array.isArray(v) ? v : []
}

function saveOrders(orders) {
  safeSet(STORAGE_KEY, orders)
}

function generateId() {
  return `cond-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// DFlow live_data payload shape isn't formally documented — probe a few common layouts.
// `keys` are candidate identifiers to match (marketId AND/OR marketTicker — the
// id is often a synthesized `live-mkt-XX-YY` fallback that DFlow's response
// would never echo back, while the ticker is what the rest of the app already
// uses against DFlow successfully).
function parseLivePrice(payload, keys) {
  if (!payload) return null
  const candidates = [payload]
  if (Array.isArray(payload)) candidates.push(...payload)
  if (Array.isArray(payload.markets)) candidates.push(...payload.markets)
  if (Array.isArray(payload.data)) candidates.push(...payload.data)

  const pickYes = (c) => {
    const yes = parseFloat(c.yesAsk ?? c.yes_ask ?? c.yesPrice ?? c.yes_price ?? c.yes)
    return Number.isFinite(yes) ? yes : null
  }

  const wanted = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
  if (wanted.length) {
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue
      const ids = [c.id, c.marketId, c.market_id, c.ticker, c.marketTicker].filter(Boolean)
      if (ids.some(id => wanted.includes(id))) {
        const yes = pickYes(c)
        if (yes !== null) return { yes, no: 1 - yes }
      }
    }
    return null
  }

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const yes = pickYes(c)
    if (yes !== null) return { yes, no: 1 - yes }
  }
  return null
}

// Derive current YES/NO ask prices from the same orderbook endpoint OrderBook
// uses on screen. yes_bids = orders to buy YES; no_bids = orders to buy NO.
// Selling YES at price P is economically the same as buying NO at (1-P), so
// the best YES ask is `1 - max(no_bid)` (and symmetrically for noAsk).
function deriveAsksFromBook(data) {
  const yesBidKeys = data?.yes_bids ? Object.keys(data.yes_bids).map(parseFloat).filter(Number.isFinite) : []
  const noBidKeys = data?.no_bids ? Object.keys(data.no_bids).map(parseFloat).filter(Number.isFinite) : []
  const maxYesBid = yesBidKeys.length ? Math.max(...yesBidKeys) : null
  const maxNoBid = noBidKeys.length ? Math.max(...noBidKeys) : null
  const yesAsk = maxNoBid !== null ? 1 - maxNoBid : null
  const noAsk = maxYesBid !== null ? 1 - maxYesBid : null
  if (yesAsk === null && noAsk === null) return null
  return {
    yes: yesAsk !== null ? yesAsk : (noAsk !== null ? 1 - noAsk : null),
    no: noAsk !== null ? noAsk : (yesAsk !== null ? 1 - yesAsk : null),
  }
}

async function fetchLivePrice(order) {
  // Order of preference, most-trusted first:
  //   1. Explicit env override (LIVE_PRICE_URL).
  //   2. Per-market orderbook — same source as the on-screen book, keyed by
  //      ticker (works even when marketId is a synthesized fallback).
  //   3. by-event live_data — the legacy path; works only when DFlow echoes
  //      our ids/tickers back.
  //   4. Simulated drift (dev only).
  if (LIVE_PRICE_URL) {
    try {
      const url = LIVE_PRICE_URL.replace('{eventTicker}', encodeURIComponent(order.eventTicker || ''))
      const res = await fetchWithRetry(url, {}, { retries: 1, timeoutMs: 3000 })
      if (res.ok) {
        const data = await res.json()
        const parsed = parseLivePrice(data, [order.marketId, order.marketTicker])
        if (parsed) return { ...parsed, source: 'dflow' }
      }
    } catch { /* fall through */ }
  }

  const bookTicker = order.marketTicker || order.marketId
  if (bookTicker) {
    try {
      const res = await fetchWithRetry(
        `${DFLOW_BASE}/api/v1/orderbook/${encodeURIComponent(bookTicker)}`,
        {}, { retries: 1, timeoutMs: 3000 },
      )
      if (res.ok) {
        const data = await res.json()
        const parsed = deriveAsksFromBook(data)
        if (parsed) return { ...parsed, source: 'orderbook' }
      }
    } catch { /* fall through */ }
  }

  if (order.eventTicker) {
    try {
      const res = await fetchWithRetry(
        `${DFLOW_BASE}/api/v1/live_data/by-event/${encodeURIComponent(order.eventTicker)}`,
        {}, { retries: 1, timeoutMs: 3000 },
      )
      if (res.ok) {
        const data = await res.json()
        const parsed = parseLivePrice(data, [order.marketId, order.marketTicker])
        if (parsed) return { ...parsed, source: 'dflow' }
      }
    } catch { /* fall through */ }
  }

  if (!ALLOW_SIMULATED_FILLS) {
    // In prod, never invent prices. Return null so the trigger loop skips this order.
    return null
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

    if (!txSigned && !ALLOW_SIMULATED_FILLS) {
      // In prod mode, a failed submit means no fill — revert to pending so
      // the next poll can try again.
      setOrders(prev => prev.map(o =>
        o.id === order.id ? { ...o, status: 'pending' } : o
      ))
      return
    }

    const fillPrice = order.side === 'yes' ? livePrice.yes : livePrice.no
    const shares = order.amount / fillPrice

    await appendPosition({
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
      closeTime: order.closeTime || null,
    })

    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'filled', filledAt: new Date().toISOString(), fillPrice, txSigned } : o
    ))

    const typeLabel = order.orderType === 'limit' ? 'Limit order' :
      order.orderType === 'stop-loss' ? 'Stop-loss' : 'Take-profit'
    const suffix = txSigned ? '' : ' (simulated)'
    addNotification(`${typeLabel} triggered${suffix}! ${order.side.toUpperCase()} ${shares.toFixed(2)} shares @ ${(fillPrice * 100).toFixed(1)}¢`)
  }, [addNotification, submitToDflow])

  // Keep a ref to orders so the interval's effect doesn't tear down
  // every time an order is added/updated. This eliminates the race
  // where a fill in flight could be missed.
  const ordersRef = useRef(orders)
  useEffect(() => { ordersRef.current = orders }, [orders])

  // Only run the polling loop when there's something to monitor.
  const hasPending = orders.some(o => o.status === 'pending')

  useEffect(() => {
    if (!hasPending) return
    const interval = setInterval(async () => {
      const pending = ordersRef.current.filter(o => o.status === 'pending')
      if (pending.length === 0) return

      const byMarket = {}
      for (const o of pending) {
        if (!byMarket[o.marketId]) byMarket[o.marketId] = []
        byMarket[o.marketId].push(o)
      }

      for (const [marketId, marketOrders] of Object.entries(byMarket)) {
        const livePrice = await fetchLivePrice(marketOrders[0])
        if (!livePrice) continue
        priceCache.current[marketId] = livePrice

        for (const order of marketOrders) {
          const currentSidePrice = order.side === 'yes' ? livePrice.yes : livePrice.no
          if (shouldTriggerOrder(order, currentSidePrice)) {
            executeOrder(order, livePrice)
          }
        }
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [hasPending, executeOrder])

  const pendingOrders = useMemo(
    () => orders.filter(o => o.status === 'pending'),
    [orders]
  )
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
