import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

// Best-effort live-price feed. Tries the DFlow WebSocket first; if the
// connection can't be established or stays silent we silently fall back
// to no-op mode. Consumers still get a flash when the upstream Markets
// provider refreshes and price values change — see usePriceFlash.
const WS_URL = 'wss://api.prod.dflow.net/ws'
const PING_INTERVAL = 25000
const RECONNECT_DELAY = 5000

const LivePricesContext = createContext(null)

function parseMessage(evt) {
  try {
    if (typeof evt.data !== 'string') return null
    const msg = JSON.parse(evt.data)
    // Accept a few shapes the server might use. We look for something
    // that identifies a market and a price. If nothing matches we drop
    // the message.
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
  const [flashes, setFlashes] = useState({})
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const subscriptionsRef = useRef(new Set())
  const flashTimers = useRef(new Map())

  const flash = useCallback((marketId, direction) => {
    setFlashes(prev => ({ ...prev, [marketId]: direction }))
    const existing = flashTimers.current.get(marketId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      setFlashes(prev => {
        const { [marketId]: _, ...rest } = prev
        return rest
      })
      flashTimers.current.delete(marketId)
    }, 500)
    flashTimers.current.set(marketId, t)
  }, [])

  const applyUpdate = useCallback((update) => {
    setPrices(prev => {
      const existing = prev[update.marketId] || {}
      const next = { ...existing }
      let direction = null
      if (update.yesAsk != null) {
        if (existing.yesAsk != null && update.yesAsk !== existing.yesAsk) {
          direction = update.yesAsk > existing.yesAsk ? 'up' : 'down'
        }
        next.yesAsk = update.yesAsk
      }
      if (update.noAsk != null) {
        if (existing.noAsk != null && update.noAsk !== existing.noAsk) {
          direction = update.noAsk > existing.noAsk ? 'up' : 'down'
        }
        next.noAsk = update.noAsk
      }
      if (direction) flash(update.marketId, direction)
      return { ...prev, [update.marketId]: next }
    })
  }, [flash])

  useEffect(() => {
    let cancelled = false
    let pingTimer = null

    const connect = () => {
      if (cancelled) return
      let ws
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        return
      }
      wsRef.current = ws

      ws.addEventListener('open', () => {
        if (cancelled) return
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
        if (!cancelled) {
          reconnectRef.current = setTimeout(connect, RECONNECT_DELAY)
        }
      }
      ws.addEventListener('close', handleClose)
      ws.addEventListener('error', () => {
        // The browser already triggers close after an error, so don't reconnect here —
        // just swallow it to keep the console quiet.
      })
    }

    connect()

    return () => {
      cancelled = true
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current && wsRef.current.readyState <= 1) {
        try { wsRef.current.close() } catch { /* ignore */ }
      }
      for (const t of flashTimers.current.values()) clearTimeout(t)
      flashTimers.current.clear()
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

  // Exposed so consumers can drive a flash when the upstream provider
  // refreshes polled data and prices change.
  const reportPriceChange = useCallback((marketId, direction) => {
    if (direction) flash(marketId, direction)
  }, [flash])

  return (
    <LivePricesContext.Provider value={{
      prices,
      flashes,
      connected,
      subscribe,
      reportPriceChange,
    }}>
      {children}
    </LivePricesContext.Provider>
  )
}

export function useLivePrices() {
  return useContext(LivePricesContext) || {
    prices: {},
    flashes: {},
    connected: false,
    subscribe: () => () => {},
    reportPriceChange: () => {},
  }
}

// Helper: call in a component to detect price changes between renders
// of a market prop and trigger a flash animation keyed by marketId.
export function usePriceFlash(marketId, yesAsk, noAsk) {
  const { flashes, reportPriceChange } = useLivePrices()
  const prevRef = useRef({ yesAsk, noAsk })

  useEffect(() => {
    const prev = prevRef.current
    if (prev.yesAsk != null && yesAsk != null && yesAsk !== prev.yesAsk) {
      reportPriceChange(marketId, yesAsk > prev.yesAsk ? 'up' : 'down')
    } else if (prev.noAsk != null && noAsk != null && noAsk !== prev.noAsk) {
      reportPriceChange(marketId, noAsk > prev.noAsk ? 'up' : 'down')
    }
    prevRef.current = { yesAsk, noAsk }
  }, [marketId, yesAsk, noAsk, reportPriceChange])

  return flashes[marketId] || null
}
