// Keeper-backed orders provider.
//
// Owns the read side of orders persisted in the keeper Worker. List is
// fetched on mount and re-polled every POLL_MS so status transitions
// (pending → armed → submitting → filled / failed) propagate without
// requiring the user to refresh.
//
// Writes go through useKeeperLimitOrder for placement and through
// `cancelOrder` here. Cancellation is best-effort — if the order has
// already moved past `pending` the API responds 409 and we surface that.

import React, {
  createContext, useCallback, useContext, useEffect,
  useMemo, useState,
} from 'react'
import { useWallet } from './useWallet'
import { listOrders, cancelOrder as apiCancel, clearOrders as apiClear, isKeeperConfigured, getSession } from '../lib/keeperApi'

const POLL_MS = 5000

const KeeperOrdersContext = createContext(null)

// Stable per-(wallet, sessionId) signature so the effect re-runs only on
// actual identity changes — not on every `refresh` callback recompile.
function sessionFingerprint(connected, address) {
  if (!connected || !isKeeperConfigured()) return ''
  const session = getSession()
  if (!session) return ''
  return `${address || ''}|${session.sessionId || ''}`
}

export function KeeperOrdersProvider({ children }) {
  const { connected, address } = useWallet()
  const [orders, setOrders] = useState([])
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!isKeeperConfigured()) return
    if (!connected) return
    const session = getSession()
    if (!session) return
    try {
      const result = await listOrders()
      // Normalize to the legacy local-order shape that ActiveOrders /
      // OrderNotifications already render. Both shapes coexist in the
      // ActiveOrders feed during the bridge period.
      const rows = (result?.orders ?? []).map((o) => ({
        id: o.id,
        marketTicker: o.market_ticker,
        marketId: o.market_id,
        eventTicker: o.event_ticker,
        side: o.side,
        orderType: o.order_type,
        triggerPrice: o.trigger_price,
        amount: o.amount_usdc,
        status: o.status,
        fillPrice: o.fill_price ?? null,
        fillSignature: o.fill_signature ?? null,
        failureReason: o.failure_reason ?? null,
        // Approval flow surfaces an spl-token delegation rather than a
        // pre-signed tx — the UI shows "Revoke approval" instead of
        // "Cancel" for these. Older rows lack `flow` so default to legacy.
        flow: o.flow ?? 'durable_nonce_legacy',
        delegatedAmountAtPlacement: o.delegated_amount_at_placement ?? null,
        approvalSignature: o.approval_signature ?? null,
        userInputAta: o.user_input_ata ?? null,
        inputMint: o.input_mint ?? null,
        outputMint: o.output_mint ?? null,
        createdAt: new Date(o.created_at).toISOString(),
        triggeredAt: o.triggered_at ? new Date(o.triggered_at).toISOString() : null,
        filledAt: o.filled_at ? new Date(o.filled_at).toISOString() : null,
        question: '',  // not stored server-side; OK to display empty
        source: 'keeper',
      }))
      setOrders(rows)
      setError(null)
    } catch (err) {
      // Don't blow away local state on transient errors — show what we last had.
      setError(err.message || 'Failed to load orders')
    }
  }, [connected])

  // One effect, one dep: the (wallet, session) fingerprint string. When
  // it changes we refresh + start polling; on unmount or change we tear
  // down. The earlier two-effect setup with a fingerprint ref had a race
  // where the ref was set BEFORE refresh resolved, causing rapid mount
  // cycles to drop the first fetch.
  const fp = sessionFingerprint(connected, address)
  useEffect(() => {
    if (!fp) {
      setOrders([])
      return
    }
    refresh()
    const interval = setInterval(refresh, POLL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp])

  const cancelOrder = useCallback(async (id) => {
    try {
      await apiCancel(id)
      // Optimistic local update — refresh shortly afterward picks up the
      // canonical state.
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'cancelled' } : o))
      setTimeout(refresh, 800)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message || 'Cancel failed' }
    }
  }, [refresh])

  // Wipe terminal-state rows server-side (cancelled / failed / expired).
  // Optional `marketTicker` narrows to a single market; otherwise clears
  // every terminal row this wallet owns.
  const clearOrders = useCallback(async ({ marketTicker } = {}) => {
    try {
      const result = await apiClear({ marketTicker })
      // Optimistically drop the rows we know server-side just deleted —
      // the next poll will reconcile if anything diverged.
      setOrders(prev => prev.filter(o => {
        const terminal = ['cancelled', 'failed', 'expired'].includes(o.status)
        if (!terminal) return true
        if (marketTicker && o.marketTicker !== marketTicker) return true
        return false
      }))
      setTimeout(refresh, 800)
      return { ok: true, removed: result?.removed ?? 0 }
    } catch (err) {
      return { ok: false, error: err.message || 'Clear failed' }
    }
  }, [refresh])

  const value = useMemo(() => ({
    orders,
    error,
    refresh,
    cancelOrder,
    clearOrders,
  }), [orders, error, refresh, cancelOrder, clearOrders])

  return (
    <KeeperOrdersContext.Provider value={value}>
      {children}
    </KeeperOrdersContext.Provider>
  )
}

export function useKeeperOrders() {
  const ctx = useContext(KeeperOrdersContext)
  if (!ctx) {
    // No provider mounted (keeper disabled or app structure changed) —
    // return an empty stub so consuming components can render harmlessly.
    return {
      orders: [],
      error: null,
      refresh: async () => {},
      cancelOrder: async () => ({ ok: false }),
      clearOrders: async () => ({ ok: false, removed: 0 }),
    }
  }
  return ctx
}
