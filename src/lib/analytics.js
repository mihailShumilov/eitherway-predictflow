// Analytics adapter. Default: no-op. Swap providers via VITE_ANALYTICS_PROVIDER.
//
// Supported:
//   - '' (unset)   — no tracking
//   - 'posthog'    — expects `posthog-js` installed + VITE_ANALYTICS_WRITE_KEY
//   - 'plausible'  — uses plausible's `window.plausible(event, {...})` (loaded via script tag)
//   - 'custom'     — POST to VITE_ANALYTICS_HOST as { event, props, ts, anon }
//
// All calls are fire-and-forget. Analytics must never block or crash the app.
//
// Identity model: PostHog distinct_id is the connected wallet's pubkey.
// Pre-connect events fall back to an anonymous device id (ANON_ID_KEY) and
// PostHog auto-aliases that to the wallet on the first identify() call.

import { ANALYTICS_PROVIDER, ANALYTICS_WRITE_KEY, ANALYTICS_HOST, IS_DEV } from '../config/env'

const ANON_ID_KEY = 'predictflow_anon_id'

function getAnonId() {
  try {
    let id = localStorage.getItem(ANON_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2))
      localStorage.setItem(ANON_ID_KEY, id)
    }
    return id
  } catch {
    return 'anon'
  }
}

let backend = null
let queue = []
let initPromise = null
let currentDistinctId = null

async function initBackend() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      if (ANALYTICS_PROVIDER === 'posthog' && ANALYTICS_WRITE_KEY) {
        // Static dynamic import so Vite produces a proper chunk URL the
        // browser can fetch — the previous `'posthog' + '-js'` trick made
        // Vite leave the bare specifier in the output, which fails at
        // runtime once `posthog-js` is a real dep.
        const mod = await import('posthog-js')
        // `defaults: '2026-01-30'` activates PostHog's full recommended
        // preset for that date: autocapture, pageviews, pageleaves,
        // exception autocapture, web vitals, heatmaps, dead-click +
        // rageclick detection, session recording. Bump the date string to
        // adopt the next preset; PostHog publishes new ones as features
        // mature. `person_profiles: 'identified_only'` is layered on top
        // so anonymous browsing doesn't create person records — only the
        // wallet's pubkey (set via identify() on connect) does.
        mod.default.init(ANALYTICS_WRITE_KEY, {
          api_host: ANALYTICS_HOST || 'https://us.i.posthog.com',
          defaults: '2026-01-30',
          person_profiles: 'identified_only',
        })
        backend = {
          track: (evt, props) => mod.default.capture(evt, props),
          identify: (id, traits) => {
            mod.default.identify(id, traits ? { ...traits, wallet_address: id } : { wallet_address: id })
            currentDistinctId = id
          },
          alias: (id) => mod.default.alias(id),
          reset: () => {
            mod.default.reset()
            currentDistinctId = null
          },
          setPersonProps: (props) => mod.default.setPersonProperties(props),
          captureException: (err, props) => mod.default.captureException?.(err, props),
          getDistinctId: () => mod.default.get_distinct_id?.() || currentDistinctId,
          getSessionId: () => mod.default.get_session_id?.() || null,
        }
      } else if (ANALYTICS_PROVIDER === 'plausible') {
        backend = {
          track: (evt, props) => window.plausible?.(evt, { props }),
          identify: () => {},
          alias: () => {},
          reset: () => {},
          setPersonProps: () => {},
          captureException: () => {},
          getDistinctId: () => null,
          getSessionId: () => null,
        }
      } else if (ANALYTICS_PROVIDER === 'custom' && ANALYTICS_HOST) {
        backend = {
          track: (evt, props) => {
            fetch(ANALYTICS_HOST, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: evt, props, ts: Date.now(), anon: getAnonId() }),
              keepalive: true,
            }).catch(() => {})
          },
          identify: (id) => { currentDistinctId = id },
          alias: () => {},
          reset: () => { currentDistinctId = null },
          setPersonProps: () => {},
          captureException: () => {},
          getDistinctId: () => currentDistinctId || getAnonId(),
          getSessionId: () => null,
        }
      } else {
        backend = {
          track: () => {}, identify: () => {}, alias: () => {}, reset: () => {},
          setPersonProps: () => {}, captureException: () => {},
          getDistinctId: () => null, getSessionId: () => null,
        }
      }
      for (const fn of queue) fn(backend)
      queue = []
    } catch {
      backend = {
        track: () => {}, identify: () => {}, alias: () => {}, reset: () => {},
        setPersonProps: () => {}, captureException: () => {},
        getDistinctId: () => null, getSessionId: () => null,
      }
    }
  })()
  return initPromise
}

function withBackend(fn) {
  if (backend) return fn(backend)
  queue.push(fn)
  initBackend()
}

export function track(event, props = {}) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.debug('[analytics]', event, props)
  }
  if (!ANALYTICS_PROVIDER) return
  withBackend(b => b.track(event, props))
}

export function identify(userId, traits) {
  if (!userId) return
  currentDistinctId = userId
  if (!ANALYTICS_PROVIDER) return
  withBackend(b => b.identify(userId, traits))
}

// Merge person properties without re-identifying (e.g. tier upgrade).
export function setUserProperties(props) {
  if (!ANALYTICS_PROVIDER || !props) return
  withBackend(b => b.setPersonProps(props))
}

// Wipe all PostHog identity state on logout / wallet disconnect so the next
// session starts as a fresh anonymous user.
export function resetAnalytics() {
  currentDistinctId = null
  if (!ANALYTICS_PROVIDER) return
  withBackend(b => b.reset())
}

// Forward a caught exception to PostHog's $exception event (autocaptured by
// posthog-js but we expose an explicit hook for try/catch sites).
export function captureException(err, props) {
  if (!ANALYTICS_PROVIDER) return
  withBackend(b => b.captureException(err, props))
}

// Returns the wallet pubkey when one has been identified, otherwise the
// device's anonymous id. Used by the keeper API client to forward
// X-POSTHOG-DISTINCT-ID so server-side events line up with the same person.
export function getDistinctId() {
  if (currentDistinctId) return currentDistinctId
  if (!ANALYTICS_PROVIDER) return getAnonId()
  if (backend) return backend.getDistinctId() || getAnonId()
  return getAnonId()
}

export function getSessionId() {
  if (!ANALYTICS_PROVIDER || !backend) return null
  return backend.getSessionId()
}

if (ANALYTICS_PROVIDER) initBackend()
