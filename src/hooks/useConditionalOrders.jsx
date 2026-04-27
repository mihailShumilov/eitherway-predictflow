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
import { track } from '../lib/analytics'
import { safeGet, safeSet, appendPosition } from '../lib/storage'
import { shouldTriggerOrder } from '../lib/triggers'
import { runOrderPipeline } from '../lib/orderTxPipeline'
import { emitLocalTrade } from '../lib/tradeEvents'
import { subscribePrices } from '../lib/dflowWs'

const OrdersContext = createContext(null)

// Dev-only simulated-fills paths in this file:
//   1. `fetchLivePrice`  — when DFlow + REST + orderbook all fail, drift
//      the last known currentPrice so triggers can still fire in dev.
//   2. `executeOrder`    — when `submitToDflow` fails, treat the order
//      as filled-at-cached-price so the dev demo flow continues.
// Both are gated on ALLOW_SIMULATED_FILLS and disabled in prod by env
// default. They serve DIFFERENT real failures; do not consolidate into a
// single guard — that would couple price fetch to broadcast.
const STORAGE_KEY = 'predictflow_conditional_orders'
// Safety fallback: a one-shot REST price probe every SAFETY_POLL_MS in case
// DFlow's WS goes silent (server-side market pause, our connection in a
// half-open state the heartbeat hasn't caught yet, etc.). The primary path
// is the prices-channel WebSocket — see the effect below.
const SAFETY_POLL_MS = 30000

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

  // Submit a real DFlow /order via the shared pipeline.
  // Returns
  //   { txSigned: true, signature } on success,
  //   { txSigned: false, retryable: bool, error: string } on failure.
  // The shared pipeline already wraps the validate → decode → whitelist →
  // preflight → sign+send sequence; we just translate its result to the
  // shape executeOrder expects.
  const submitToDflow = useCallback(async (order) => {
    if (!address) return { txSigned: false, retryable: true, error: 'Wallet not connected' }
    const outputMint = order.side === 'yes' ? order.yesMint : order.noMint
    if (!outputMint) return { txSigned: false, retryable: false, error: 'Market has no outcome mint' }
    const provider = activeWallet?.getProvider?.()
    const result = await runOrderPipeline({
      inputMint: USDC_MINT,
      outputMint,
      amountLamports: Math.floor(order.amount * 1e6),
      userPublicKey: address,
      idempotencyPrefix: 'cond',
      provider,
      preflight: true,
      broadcast: 'send',
    })
    if (result.ok) {
      return { txSigned: true, signature: result.signature, error: null }
    }
    return { txSigned: false, retryable: result.retryable, error: result.error }
  }, [activeWallet, address])

  const executeOrder = useCallback(async (order, livePrice) => {
    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'executing' } : o
    ))

    const result = await submitToDflow(order)
    const txSigned = result.txSigned

    if (!txSigned) {
      if (ALLOW_SIMULATED_FILLS) {
        // dev-mode pass-through — fall through to the simulated-fill path below
      } else if (result.retryable) {
        // Transient (RPC, network, user-rejected sign). Revert to pending so
        // the next 5s tick retries — no notification spam.
        setOrders(prev => prev.map(o =>
          o.id === order.id ? { ...o, status: 'pending' } : o
        ))
        return
      } else {
        // Permanent failure (bad mint, 4xx, decode/whitelist rejection).
        // Mark failed so we don't loop forever, and tell the user why.
        setOrders(prev => prev.map(o =>
          o.id === order.id ? { ...o, status: 'failed', failedAt: new Date().toISOString(), error: result.error } : o
        ))
        track('conditional_order_failed', { marketId: order.marketId, orderType: order.orderType, reason: result.error })
        addNotification(`Order failed: ${result.error}`)
        return
      }
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
      txSignature: result.signature || (txSigned ? 'signed' : 'simulated'),
      question: order.question,
      eventTitle: order.eventTitle,
      category: order.category,
      closeTime: order.closeTime || null,
    })

    setOrders(prev => prev.map(o =>
      o.id === order.id ? { ...o, status: 'filled', filledAt: new Date().toISOString(), fillPrice, txSigned } : o
    ))

    // Surface on the per-market trade tape so RecentTrades shows the fill
    // optimistically until DFlow's indexer catches up.
    emitLocalTrade({
      id: `local-${result.signature || order.id}`,
      marketId: order.marketId,
      ticker: order.marketTicker || order.marketId,
      time: new Date().toISOString(),
      side: order.side === 'no' ? 'sell' : 'buy',
      price: fillPrice,
      shares: parseFloat(shares.toFixed(2)),
      amount: order.amount,
      txSignature: result.signature,
    })

    const typeLabel = order.orderType === 'limit' ? 'Limit order' :
      order.orderType === 'stop-loss' ? 'Stop-loss' : 'Take-profit'
    const suffix = txSigned ? '' : ' (simulated)'
    addNotification(`${typeLabel} triggered${suffix}! ${order.side.toUpperCase()} ${shares.toFixed(2)} shares @ ${(fillPrice * 100).toFixed(1)}¢`)
  }, [addNotification, submitToDflow])

  // Keep refs so the WS subscription effect doesn't tear down every time an
  // order is added/updated. Re-subscribing on every state change would miss
  // fast-firing triggers and churn DFlow with subscribe/unsubscribe spam.
  const ordersRef = useRef(orders)
  useEffect(() => { ordersRef.current = orders }, [orders])
  const executeOrderRef = useRef(executeOrder)
  useEffect(() => { executeOrderRef.current = executeOrder }, [executeOrder])
  // Tracks orders currently mid-execute so a double-tick on the WS
  // (especially during reconnect replays) doesn't fire the same order twice.
  const inFlightExecuteRef = useRef(new Set())

  // Stable signature of "the set of tickers we need a price feed for".
  // Effect re-runs when this string changes — i.e., when a new market gets a
  // pending order or the last order on a market clears — so subscriptions
  // stay in sync with what we actually care about.
  const pendingTickersKey = useMemo(() => {
    const set = new Set()
    for (const o of orders) {
      if (o.status !== 'pending') continue
      const t = o.marketTicker || o.marketId
      if (t) set.add(t)
    }
    return [...set].sort().join(',')
  }, [orders])

  useEffect(() => {
    if (!pendingTickersKey) return
    const tickers = pendingTickersKey.split(',')

    // Pick the right side of the book for an order:
    //   limit (BUY)  → ASK of that side (price you'd pay to buy)
    //   stop-loss / take-profit (SELL) → BID of that side (price you'd
    //                                    receive on sale)
    // Mirrors worker/src/lib/triggers.ts#priceForOrder. Reading ASK for a
    // sell trigger fires 5–20 bps off in a wide-spread market.
    const priceForOrder = (cache, side, orderType) => {
      if (!cache) return null
      if (orderType === 'limit') {
        return side === 'yes' ? cache.yesAsk : cache.noAsk
      }
      return side === 'yes' ? cache.yesBid : cache.noBid
    }

    const inFlightRef = inFlightExecuteRef.current
    const evalForTicker = (ticker) => {
      const cached = priceCache.current[ticker]
      if (!cached) return
      const matching = ordersRef.current.filter(o =>
        o.status === 'pending' && (o.marketTicker || o.marketId) === ticker,
      )
      for (const order of matching) {
        // Frontend execution race guard — the WS can deliver two ticks in
        // quick succession (especially during reconnect replay), and
        // executeOrder is async. Without this gate we'd sign and broadcast
        // the same trade twice. The backend has a CAS guard too; this is
        // belt + suspenders for the legacy localStorage path.
        if (inFlightRef.has(order.id)) continue
        const sidePrice = priceForOrder(cached, order.side, order.orderType)
        if (sidePrice == null) continue
        if (shouldTriggerOrder(order, sidePrice)) {
          inFlightRef.add(order.id)
          Promise.resolve(executeOrderRef.current(order, {
            yes: cached.yesAsk ?? cached.yesBid,
            no: cached.noAsk ?? cached.noBid,
            source: cached.source,
          })).finally(() => inFlightRef.delete(order.id))
        }
      }
    }

    // Primary path — DFlow `prices` WS channel. Sub-second trigger latency.
    const unsubs = []
    for (const ticker of tickers) {
      const off = subscribePrices(ticker, (msg) => {
        const yesAsk = parseFloat(msg.yes_ask)
        const yesBid = parseFloat(msg.yes_bid)
        const noAsk = parseFloat(msg.no_ask)
        const noBid = parseFloat(msg.no_bid)
        const yesAskOk = Number.isFinite(yesAsk)
        const yesBidOk = Number.isFinite(yesBid)
        const noAskOk = Number.isFinite(noAsk)
        const noBidOk = Number.isFinite(noBid)
        if (!yesAskOk && !yesBidOk && !noAskOk && !noBidOk) return
        // Cache the full bid/ask quad so limit orders evaluate against
        // asks while stop-loss / take-profit evaluate against bids. Fill
        // missing sides from the inverse (yesAsk = 1 − noBid, etc.) so a
        // one-sided book still produces usable triggers.
        priceCache.current[ticker] = {
          yesAsk: yesAskOk ? yesAsk : (noBidOk ? 1 - noBid : null),
          yesBid: yesBidOk ? yesBid : (noAskOk ? 1 - noAsk : null),
          noAsk: noAskOk ? noAsk : (yesBidOk ? 1 - yesBid : null),
          noBid: noBidOk ? noBid : (yesAskOk ? 1 - yesAsk : null),
          source: 'ws',
        }
        evalForTicker(ticker)
      })
      unsubs.push(off)
    }

    // Safety fallback — REST probe every 30s. WS heartbeat in dflowWs.js
    // catches dead connections, but a server-side market pause can leave
    // the connection healthy with no messages for a given ticker. The REST
    // probe makes sure we don't sit forever waiting for a tick that
    // doesn't come.
    const safetyTimer = setInterval(async () => {
      for (const ticker of tickers) {
        const matching = ordersRef.current.filter(o =>
          o.status === 'pending' && (o.marketTicker || o.marketId) === ticker,
        )
        if (matching.length === 0) continue
        const livePrice = await fetchLivePrice(matching[0])
        if (livePrice) {
          // fetchLivePrice returns the legacy {yes, no} ASK pair. Promote to
          // the bid/ask quad shape — for sells we treat ASK as the best
          // available BID approximation in the absence of book depth.
          priceCache.current[ticker] = {
            yesAsk: livePrice.yes,
            yesBid: livePrice.yes,
            noAsk: livePrice.no,
            noBid: livePrice.no,
            source: livePrice.source || 'rest',
          }
          evalForTicker(ticker)
        }
      }
    }, SAFETY_POLL_MS)

    return () => {
      for (const off of unsubs) off()
      clearInterval(safetyTimer)
    }
  }, [pendingTickersKey])

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
