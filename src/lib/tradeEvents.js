// Lightweight pub/sub for "the user just placed a trade locally" — used to
// optimistically prepend the trade in RecentTrades before DFlow's indexer
// catches up. Decoupled from React so non-component callers (useTradeSubmit,
// future DCA executor, etc.) can emit without prop drilling.

const target = typeof window !== 'undefined' ? new EventTarget() : null
const EVENT_NAME = 'pf:local-trade'

export function emitLocalTrade(trade) {
  if (!target || !trade) return
  target.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: trade }))
}

export function subscribeLocalTrades(handler) {
  if (!target) return () => {}
  const listener = (e) => handler(e.detail)
  target.addEventListener(EVENT_NAME, listener)
  return () => target.removeEventListener(EVENT_NAME, listener)
}
