// Safe localStorage helpers + schema migrations + a coordinated writer
// for the shared `predictflow_positions` ledger (written from TradePanel,
// useDCA, and useConditionalOrders — without serialization these would race).

const STORAGE_VERSION_KEY = 'predictflow_storage_version'
const CURRENT_VERSION = 2

export function safeGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function safeRemove(key) {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

// ── Migrations ────────────────────────────────────────────────────────
// Run once on boot. Each migration takes the app from version N → N+1.
// Schema lives only in localStorage (no server), so migrations must be
// idempotent and never throw — worst case we reset a key.
const migrations = [
  // v0 → v1: ensure predictflow_positions entries have a 'status' field.
  () => {
    const positions = safeGet('predictflow_positions', [])
    if (!Array.isArray(positions)) return
    const fixed = positions.map(p => ({ status: 'filled', ...p }))
    safeSet('predictflow_positions', fixed)
  },
  // v1 → v2: ensure conditional orders have 'createdAt' ISO strings.
  () => {
    const orders = safeGet('predictflow_conditional_orders', [])
    if (!Array.isArray(orders)) return
    const fixed = orders.map(o => ({
      ...o,
      createdAt: o.createdAt || new Date().toISOString(),
    }))
    safeSet('predictflow_conditional_orders', fixed)
  },
]

export function runMigrations() {
  const current = Number(safeGet(STORAGE_VERSION_KEY, 0)) || 0
  if (current >= CURRENT_VERSION) return
  for (let v = current; v < CURRENT_VERSION; v++) {
    try { migrations[v]?.() } catch { /* ignore — each step is best-effort */ }
  }
  safeSet(STORAGE_VERSION_KEY, CURRENT_VERSION)
}

// ── Coordinated position writes ────────────────────────────────────────
// Serialize read-modify-write on `predictflow_positions` through a single
// chained promise so concurrent callers (DCA tick + manual trade +
// conditional-order fire) can't clobber each other.
let positionsChain = Promise.resolve()

function withPositionsLock(fn) {
  const next = positionsChain.then(fn, fn)
  positionsChain = next.catch(() => {})
  return next
}

export function appendPosition(entry) {
  return withPositionsLock(() => {
    const current = safeGet('predictflow_positions', [])
    const arr = Array.isArray(current) ? current : []
    arr.push(entry)
    safeSet('predictflow_positions', arr)
    bumpPositionsVersion()
    return entry
  })
}

export function getPositions() {
  const current = safeGet('predictflow_positions', [])
  return Array.isArray(current) ? current : []
}

// Monotonic version counter bumped on every append so components that need
// "did positions change?" can subscribe without re-reading storage.
let positionsVersion = 0
const versionListeners = new Set()

export function subscribePositions(listener) {
  versionListeners.add(listener)
  return () => versionListeners.delete(listener)
}

export function bumpPositionsVersion() {
  positionsVersion++
  for (const l of versionListeners) l(positionsVersion)
}

export function getPositionsVersion() {
  return positionsVersion
}
