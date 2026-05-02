// Typed client for the PredictFlow keeper Worker.
//
// All write endpoints require a session token — issued by the SIWS flow
// in walletAuth.js and stashed in localStorage. This module is concerned
// only with HTTP shape; auth state lives in walletAuth.

import { KEEPER_API_BASE } from '../config/env'

const SESSION_KEY = 'predictflow_keeper_session'

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.token || !parsed?.expiresAt) return null
    if (parsed.expiresAt < Date.now()) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

export function isKeeperConfigured() {
  return !!KEEPER_API_BASE
}

class KeeperApiError extends Error {
  constructor(status, code, detail, requestId) {
    super(`keeper ${status}: ${code}${requestId ? ` (req ${requestId})` : ''}`)
    this.status = status
    this.code = code
    this.detail = detail
    this.requestId = requestId
  }
}

async function request(path, options = {}) {
  if (!KEEPER_API_BASE) {
    throw new KeeperApiError(0, 'keeper_not_configured', 'VITE_KEEPER_API_BASE is unset')
  }
  const session = options.requireAuth === false ? null : getSession()
  if (options.requireAuth !== false && !session) {
    throw new KeeperApiError(401, 'no_session', 'Sign in with your wallet first')
  }
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  }
  if (session) headers.authorization = `Bearer ${session.token}`

  const res = await fetch(`${KEEPER_API_BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  // 204 No Content
  if (res.status === 204) return null
  let payload
  try { payload = await res.json() } catch { payload = null }
  // The server returns a request id in the `x-request-id` header AND in
  // the JSON body for error responses. Either source works — header is
  // safer because it survives a malformed body.
  const requestId = res.headers.get('x-request-id') || payload?.requestId || null
  if (!res.ok) {
    const code = payload?.error || `http_${res.status}`
    throw new KeeperApiError(res.status, code, payload?.detail ?? payload, requestId)
  }
  return payload
}

// Auth endpoints (unauthenticated)
export async function postChallenge(wallet) {
  return request('/auth/challenge', {
    method: 'POST',
    body: { wallet },
    requireAuth: false,
  })
}

export async function postVerify({ wallet, nonce, signature }) {
  return request('/auth/verify', {
    method: 'POST',
    body: { wallet, nonce, signature },
    requireAuth: false,
  })
}

export async function getMe() {
  return request('/auth/me', { requireAuth: false })
}

export async function postLogout() {
  return request('/auth/logout', { method: 'POST' })
}

// Order endpoints (authenticated)
export async function listOrders({ status, market } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (market) params.set('market', market)
  const q = params.toString() ? `?${params.toString()}` : ''
  return request(`/orders${q}`)
}

export async function getOrder(id) {
  return request(`/orders/${encodeURIComponent(id)}`)
}

export async function placeOrder(payload) {
  return request('/orders', { method: 'POST', body: payload })
}

// Public config — exposes the keeper's executor pubkey for the
// approval-flow path. The frontend uses this as the `delegate` argument to
// spl-token `approve` when placing a limit order. Cached on first read.
let _configCache = null
export async function getConfig({ refresh = false } = {}) {
  if (_configCache && !refresh) return _configCache
  // /config doesn't require auth — request() requires a session by default,
  // so we drop that requirement explicitly.
  _configCache = await request('/config', { requireAuth: false })
  return _configCache
}

export async function cancelOrder(id) {
  return request(`/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

// Bulk-cancel non-terminal approval-flow orders whose input mint is in
// the supplied list. Used by the revoke flow so the keeper stops firing
// against a wiped delegation.
export async function cancelOrdersByMint({ mints }) {
  return request('/orders/cancel-by-mint', { method: 'POST', body: { mints } })
}

// Hard-delete terminal-state orders (cancelled / failed / expired). When
// `marketTicker` is set, only that market's rows are deleted. Returns
// `{ removed: number }`.
export async function clearOrders({ marketTicker } = {}) {
  const q = marketTicker ? `?market=${encodeURIComponent(marketTicker)}` : ''
  return request(`/orders${q}`, { method: 'DELETE' })
}

// Durable nonce endpoints (Phase 2 — backend defines these alongside orders)
export async function getDurableNonce({ marketTicker }) {
  const q = `?market=${encodeURIComponent(marketTicker)}`
  return request(`/durable-nonces${q}`)
}

export async function registerDurableNonce({ pubkey, marketTicker, currentNonce }) {
  return request('/durable-nonces', {
    method: 'POST',
    body: { pubkey, marketTicker, currentNonce },
  })
}

export { KeeperApiError }
