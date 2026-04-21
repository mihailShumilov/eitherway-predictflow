import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import { DFLOW_WS_URL } from '../config/env'

// Best-effort live-price feed. Tries the DFlow WebSocket first; if the
// connection can't be established or stays silent we silently fall back
// to no-op mode. Consumers still get a flash when the upstream Markets
// provider refreshes and price values change — see usePriceFlash.
const WS_URL = DFLOW_WS_URL
const PING_INTERVAL = 25000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60000
const MAX_CONSECUTIVE_FAILURES = 10
const FLASH_DURATION_MS = 500

// ─── Module-level flash store ────────────────────────────────────────
// Kept out of React state/context so subscribing to one market doesn't
// re-render components watching a different market.
const flashState = new Map()               // marketId -> 'up' | 'down'
const flashListeners = new Map()           // marketId -> Set<listener>
const flashTimers = new Map()              // marketId -> timeoutId

function notify(marketId) {
  const set = flashListeners.get(marketId)
  if (!set) return
  for (const l of set) l()
}

function setFlash(marketId, direction) {
  flashState.set(marketId, direction)
  notify(marketId)
  const prev = flashTimers.get(marketId)
  if (prev) clearTimeout(prev)
  const t = setTimeout(() => {
    flashState.delete(marketId)
    flashTimers.delete(marketId)
    notify(marketId)
  }, FLASH_DURATION_MS)
  flashTimers.set(marketId, t)
}

export function reportPriceDelta(marketId, oldVal, newVal) {
  if (oldVal == null || newVal == null || oldVal === newVal) return
  setFlash(marketId, newVal > oldVal ? 'up' : 'down')
}

// ─── WebSocket live feed (kept in React for connection lifecycle) ────
const LivePricesContext = createContext(null)

function parseMessage(evt) {
  try {
    if (typeof evt.data !== 'string') return null
    const msg = JSON.parse(evt.data)
    const marketId = msg.marketId || msg.market_id || msg.market || msg.id
    const yesAsk = msg.yesAsk ?? msg.yes_ask ?? msg.yesPrice ?? msg.yes_price
    const noAsk = msg.noAsk ?? msg.no_ask ?? msg.noPrice ?? msg.no_price
    if (!marketId) return null
    const update = { marketId }
    if (Number.isFinite(Number(yesAsk))) update.yesAsk = Number(yesAsk)
    if (Number.isFinite(Number(noAsk))) update.noAsk = Number(noAsk)
    if (update.yesAsk == null && update.noAsk == null) return null
    return update
  } catch {
    return null
  }
}

export function LivePricesProvider({ children }) {
  const [prices, setPrices] = useState({})
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const subscriptionsRef = useRef(new Set())

  const applyUpdate = useCallback((update) => {
    setPrices(prev => {
      const existing = prev[update.marketId] || {}
      const next = { ...existing }
      if (update.yesAsk != null) {
        reportPriceDelta(update.marketId, existing.yesAsk, update.yesAsk)
        next.yesAsk = update.yesAsk
      }
      if (update.noAsk != null) {
        reportPriceDelta(update.marketId, existing.noAsk, update.noAsk)
        next.noAsk = update.noAsk
      }
      return { ...prev, [update.marketId]: next }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let pingTimer = null
    let failures = 0
    let circuitOpen = false

    const nextBackoffMs = () => Math.min(RECONNECT_BASE_MS * Math.pow(2, failures), RECONNECT_MAX_MS)

    const connect = () => {
      if (cancelled || circuitOpen) return
      if (!WS_URL) return
      let ws
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        failures++
        if (failures >= MAX_CONSECUTIVE_FAILURES) { circuitOpen = true; return }
        reconnectRef.current = setTimeout(connect, nextBackoffMs())
        return
      }
      wsRef.current = ws

      ws.addEventListener('open', () => {
        if (cancelled) return
        failures = 0
        setConnected(true)
        for (const marketId of subscriptionsRef.current) {
          try { ws.send(JSON.stringify({ type: 'subscribe', marketId })) } catch { /* ignore */ }
        }
        pingTimer = setInterval(() => {
          try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ }
        }, PING_INTERVAL)
      })

      ws.addEventListener('message', (evt) => {
        const update = parseMessage(evt)
        if (update) applyUpdate(update)
      })

      const handleClose = () => {
        setConnected(false)
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
        if (cancelled) return
        failures++
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          circuitOpen = true
          return
        }
        reconnectRef.current = setTimeout(connect, nextBackoffMs())
      }
      ws.addEventListener('close', handleClose)
      ws.addEventListener('error', () => { /* close follows */ })
    }

    connect()

    return () => {
      cancelled = true
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current && wsRef.current.readyState <= 1) {
        try { wsRef.current.close() } catch { /* ignore */ }
      }
      for (const t of flashTimers.values()) clearTimeout(t)
      flashTimers.clear()
      flashState.clear()
    }
  }, [applyUpdate])

  const subscribe = useCallback((marketId) => {
    if (!marketId) return () => {}
    subscriptionsRef.current.add(marketId)
    const ws = wsRef.current
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'subscribe', marketId })) } catch { /* ignore */ }
    }
    return () => {
      subscriptionsRef.current.delete(marketId)
      const w = wsRef.current
      if (w && w.readyState === 1) {
        try { w.send(JSON.stringify({ type: 'unsubscribe', marketId })) } catch { /* ignore */ }
      }
    }
  }, [])

  return (
    <LivePricesContext.Provider value={{ prices, connected, subscribe }}>
      {children}
    </LivePricesContext.Provider>
  )
}

export function useLivePrices() {
  return useContext(LivePricesContext) || {
    prices: {}, connected: false, subscribe: () => () => {},
  }
}

// Call this in a component with per-render `yesAsk`/`noAsk` props and
// get back this market's current flash direction (or null). Only this
// card re-renders when ITS market flashes.
export function usePriceFlash(marketId, yesAsk, noAsk) {
  const prevRef = useRef({ yesAsk, noAsk })

  useEffect(() => {
    const prev = prevRef.current
    reportPriceDelta(marketId, prev.yesAsk, yesAsk)
    reportPriceDelta(marketId, prev.noAsk, noAsk)
    prevRef.current = { yesAsk, noAsk }
  }, [marketId, yesAsk, noAsk])

  return useSyncExternalStore(
    (listener) => {
      if (!flashListeners.has(marketId)) flashListeners.set(marketId, new Set())
      flashListeners.get(marketId).add(listener)
      return () => {
        const set = flashListeners.get(marketId)
        if (!set) return
        set.delete(listener)
        if (set.size === 0) flashListeners.delete(marketId)
      }
    },
    () => flashState.get(marketId) || null,
    () => null,
  )
}
