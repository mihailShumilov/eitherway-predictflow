// DFlow WebSocket client — singleton.
//
// One connection multiplexes the three DFlow real-time channels (`prices`,
// `orderbook`, `trades`) across every component that wants real-time data.
// Subscribers register interest by (channel, ticker, handler); the manager
// ref-counts subscriptions and only sends `subscribe` / `unsubscribe` to
// DFlow on the first/last subscriber for a given (channel, ticker) pair.
//
// Reconnect: exponential backoff capped at 30s. On reconnect we re-send
// every subscription that still has at least one local subscriber, so
// callers don't need to re-register after a disconnect.
//
// Auth: the dev DFlow endpoint requires no auth and is what we point at by
// default. The prod endpoint requires `x-api-key` on the HTTP upgrade,
// which browsers cannot set — that path goes through a server-side proxy.

import { DFLOW_WS_URL } from '../config/env'
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  HEARTBEAT_TIMEOUT_MS, HEARTBEAT_CHECK_MS,
} from './wsConstants'

// Local subscription registry: key = `${channel}|${ticker}`, value = Set<handler>.
const subs = new Map()

// Live socket + connection state.
let ws = null
let connectAttempts = 0
let reconnectTimer = null
let lastMessageAt = 0
let heartbeatTimer = null
let opening = false

function key(channel, ticker) {
  return `${channel}|${ticker}`
}

function ensureSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (opening) return
  opening = true

  const sock = new WebSocket(DFLOW_WS_URL)
  ws = sock

  sock.addEventListener('open', () => {
    opening = false
    connectAttempts = 0
    lastMessageAt = Date.now()
    startHeartbeat()
    // (Re-)subscribe everything we have local interest in. The server may
    // have lost state across a disconnect, so we always send fresh subs.
    const grouped = new Map()
    for (const k of subs.keys()) {
      const [channel, ticker] = k.split('|')
      if (!grouped.has(channel)) grouped.set(channel, new Set())
      grouped.get(channel).add(ticker)
    }
    for (const [channel, tickers] of grouped) {
      sock.send(JSON.stringify({
        type: 'subscribe',
        channel,
        tickers: [...tickers],
      }))
    }
  })

  sock.addEventListener('message', (event) => {
    lastMessageAt = Date.now()
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const ch = msg.channel
    const ticker = msg.market_ticker
    if (!ch || !ticker) return
    const k = key(ch, ticker)
    const handlers = subs.get(k)
    if (!handlers) return
    for (const h of handlers) {
      try { h(msg) } catch (err) { console.error('dflowWs handler error', err) }
    }
  })

  sock.addEventListener('close', () => {
    opening = false
    stopHeartbeat()
    if (subs.size > 0) scheduleReconnect()
  })

  sock.addEventListener('error', () => {
    // Most browsers fire close right after error; let close handle reconnect.
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** connectAttempts, RECONNECT_MAX_MS)
  connectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (subs.size > 0) ensureSocket()
  }, delay)
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
      // Server isn't talking. Force-close to trigger reconnect — DFlow's
      // server may keep half-open connections that look healthy locally.
      try { ws?.close() } catch { /* */ }
    }
  }, HEARTBEAT_CHECK_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function sendIfOpen(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
  // If not open yet, the open handler will re-send everything in `subs`.
}

// Internal generic subscribe; channel-specific helpers wrap this.
function subscribe(channel, ticker, handler) {
  if (!ticker || !handler) return () => {}
  const k = key(channel, ticker)
  let handlers = subs.get(k)
  const isFirst = !handlers || handlers.size === 0
  if (!handlers) {
    handlers = new Set()
    subs.set(k, handlers)
  }
  handlers.add(handler)

  ensureSocket()
  if (isFirst) sendIfOpen({ type: 'subscribe', channel, tickers: [ticker] })

  return () => {
    const set = subs.get(k)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) {
      subs.delete(k)
      sendIfOpen({ type: 'unsubscribe', channel, tickers: [ticker] })
      // If nothing is left, close the socket so we don't keep an idle
      // connection. It'll re-open lazily on the next subscribe.
      if (subs.size === 0 && ws) {
        try { ws.close() } catch { /* */ }
      }
    }
  }
}

// `prices` payload (raw from DFlow):
//   { channel: "prices", type: "ticker", market_ticker, yes_bid, yes_ask, no_bid, no_ask }
// Strings or null. Subscribers get the raw shape — coerce in the consumer.
export function subscribePrices(ticker, handler) {
  return subscribe('prices', ticker, handler)
}

export function subscribeOrderbook(ticker, handler) {
  return subscribe('orderbook', ticker, handler)
}

export function subscribeTrades(ticker, handler) {
  return subscribe('trades', ticker, handler)
}

// For tests: reset the singleton. Only call from test setups.
export function _resetForTests() {
  if (ws) {
    try { ws.close() } catch { /* */ }
    ws = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHeartbeat()
  subs.clear()
  connectAttempts = 0
  opening = false
}
