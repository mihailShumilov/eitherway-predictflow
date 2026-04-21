// Analytics adapter. Default: no-op. Swap providers via VITE_ANALYTICS_PROVIDER.
//
// Supported:
//   - '' (unset)   — no tracking
//   - 'posthog'    — expects `posthog-js` installed + VITE_ANALYTICS_WRITE_KEY
//   - 'plausible'  — uses plausible's `window.plausible(event, {...})` (loaded via script tag)
//   - 'custom'     — POST to VITE_ANALYTICS_HOST as { event, props, ts, anon }
//
// All calls are fire-and-forget. Analytics must never block or crash the app.

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

async function initBackend() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      if (ANALYTICS_PROVIDER === 'posthog' && ANALYTICS_WRITE_KEY) {
        const moduleId = 'posthog' + '-js'
        const mod = await import(moduleId)
        mod.default.init(ANALYTICS_WRITE_KEY, {
          api_host: ANALYTICS_HOST || 'https://app.posthog.com',
          capture_pageview: false,
        })
        backend = {
          track: (evt, props) => mod.default.capture(evt, props),
          identify: (id, traits) => mod.default.identify(id, traits),
        }
      } else if (ANALYTICS_PROVIDER === 'plausible') {
        backend = {
          track: (evt, props) => window.plausible?.(evt, { props }),
          identify: () => {},
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
          identify: () => {},
        }
      } else {
        backend = { track: () => {}, identify: () => {} }
      }
      for (const fn of queue) fn(backend)
      queue = []
    } catch {
      backend = { track: () => {}, identify: () => {} }
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
  if (!ANALYTICS_PROVIDER) return
  withBackend(b => b.identify(userId, traits))
}

if (ANALYTICS_PROVIDER) initBackend()
