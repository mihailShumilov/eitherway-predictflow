import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react'
import { useWallet } from './useWallet'
import {
  DFLOW_PROXY_BASE as DFLOW_BASE,
  DFLOW_ORDER_URL,
  USDC_MINT,
  LIVE_PRICE_URL,
  ALLOW_SIMULATED_FILLS,
} from '../config/env'
import { fetchWithRetry, generateIdempotencyKey } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { track } from '../lib/analytics'
import { safeGet, safeSet, appendPosition } from '../lib/storage'
import { shouldTriggerOrder } from '../lib/triggers'
import { decodeDflowTransaction, assertAllowedPrograms, validateTxPayload } from '../lib/txDecoder'
import { preflightTransaction } from '../lib/solanaPreflight'
import { safeErrorMessage } from '../lib/errorMessage'
import { emitLocalTrade } from '../lib/tradeEvents'

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

  // Submit a real DFlow /order + sign + send. Returns
  //   { txSigned: true, signature, error: null } on success,
  //   { txSigned: false, retryable: bool, error: string } on failure.
  // The earlier impl was broken in two ways: it passed raw tx bytes to
  // signTransaction (wallets need a decoded Transaction object), and it
  // never broadcast the signed tx to the chain — so even when triggers
  // fired the order could not actually fill.
  const submitToDflow = useCallback(async (order) => {
    if (!address) return { txSigned: false, retryable: true, error: 'Wallet not connected' }
    const outputMint = order.side === 'yes' ? order.yesMint : order.noMint
    if (!outputMint) return { txSigned: false, retryable: false, error: 'Market has no outcome mint' }

    try {
      const amountLamports = Math.floor(order.amount * 1e6)
      const idempotencyKey = generateIdempotencyKey('cond')
      const url = `${DFLOW_ORDER_URL}?inputMint=${USDC_MINT}&outputMint=${encodeURIComponent(outputMint)}&amount=${amountLamports}&userPublicKey=${address}`
      const res = await fetchWithRetry(url, {
        headers: { 'X-Idempotency-Key': idempotencyKey },
      }, { retries: 1, timeoutMs: 8000 })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        // 4xx = caller error (wrong mint, bad amount, KYC) — don't keep retrying.
        const retryable = res.status >= 500
        return { txSigned: false, retryable, error: `Order API ${res.status}: ${body.slice(0, 200)}` }
      }
      const data = await res.json()

      const payloadCheck = validateTxPayload(data.transaction)
      if (!payloadCheck.ok) return { txSigned: false, retryable: false, error: payloadCheck.error }

      const provider = activeWallet?.getProvider?.()
      if (!provider) return { txSigned: false, retryable: true, error: 'No wallet provider' }
      if (!data.transaction) return { txSigned: false, retryable: false, error: 'Order API returned no transaction' }

      // Same security pipeline as submitMarketTrade: decode + program
      // whitelist before signing, preflight against a Solana RPC.
      const decoded = decodeDflowTransaction(data.transaction)
      if (!decoded.ok) return { txSigned: false, retryable: false, error: decoded.error }
      const whitelist = assertAllowedPrograms(decoded.tx)
      if (!whitelist.ok) return { txSigned: false, retryable: false, error: whitelist.error }

      const txBytes = typeof data.transaction === 'string'
        ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
        : data.transaction
      const pf = await preflightTransaction(txBytes)
      if (!pf.ok) {
        if (pf.unreachable) return { txSigned: false, retryable: true, error: 'RPC unreachable' }
        return { txSigned: false, retryable: false, error: pf.error?.toString?.() || 'Preflight failed' }
      }

      let signature = null
      if (typeof provider.signAndSendTransaction === 'function') {
        const sent = await provider.signAndSendTransaction(decoded.tx)
        signature = sent?.signature || sent?.publicKey || 'signed'
      } else if (typeof provider.signTransaction === 'function') {
        // Older wallet providers without combined sign+send. The decoded
        // Transaction must be passed (NOT raw bytes — that's what was broken
        // before). We still need to broadcast the signed result, but most
        // app wallets in this codebase implement signAndSendTransaction so
        // this branch is rarely hit.
        const signedTx = await provider.signTransaction(decoded.tx)
        const sig = signedTx?.signatures?.[0]
        const sigBytes = sig?.signature || (sig instanceof Uint8Array ? sig : null)
        signature = sigBytes
          ? Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')
          : 'signed'
      } else {
        return { txSigned: false, retryable: false, error: 'Wallet does not support signing' }
      }

      return { txSigned: true, signature, error: null }
    } catch (err) {
      return {
        txSigned: false,
        // User-rejected sign or transient network errors should be retryable;
        // on-chain rejections (custom program errors) typically aren't.
        retryable: true,
        error: safeErrorMessage(err, 'Order submission failed'),
      }
    }
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
