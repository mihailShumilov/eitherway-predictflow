// Error reporter with a Sentry-compatible surface but zero dependencies by default.
// When VITE_SENTRY_DSN is set, dynamically imports @sentry/browser at runtime.
// If that package isn't installed, falls back silently to console.debug in dev
// and /dev/null in prod — the app never crashes on reporting.

import { SENTRY_DSN, IS_DEV, MODE } from '../config/env'
import { captureException as analyticsCaptureException } from './analytics'

let backend = null
let queue = []
let initPromise = null

function initSentry() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      // Dynamic import — @sentry/browser is optional. Install it when you
      // actually want to send errors upstream. String-concatenating the
      // module id defeats Vite's static dependency scan so the app still
      // builds when the package isn't installed.
      const moduleId = '@sentry' + '/browser'
      const mod = await import(moduleId)
      mod.init({
        dsn: SENTRY_DSN,
        environment: MODE,
        tracesSampleRate: 0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      })
      backend = {
        captureException: (err, ctx) => mod.captureException(err, ctx ? { extra: ctx } : undefined),
        captureMessage: (msg, ctx) => mod.captureMessage(msg, ctx ? { extra: ctx } : undefined),
        setUser: (user) => mod.setUser(user),
      }
      for (const fn of queue) fn(backend)
      queue = []
    } catch {
      // package missing or init failed — degrade to noop
      backend = {
        captureException: () => {},
        captureMessage: () => {},
        setUser: () => {},
      }
    }
  })()
  return initPromise
}

function withBackend(fn) {
  if (backend) return fn(backend)
  if (SENTRY_DSN) {
    queue.push(fn)
    initSentry()
  }
}

export function reportError(err, context) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.debug('[reportError]', err, context)
  }
  withBackend(b => b.captureException(err, context))
  // Mirror to PostHog as a $exception event so error analytics are visible
  // even when no Sentry DSN is configured.
  try { analyticsCaptureException(err, context) } catch { /* never throw */ }
}

export function reportMessage(msg, context) {
  withBackend(b => b.captureMessage(msg, context))
}

export function identifyUser(user) {
  withBackend(b => b.setUser(user))
}

// Kick off init on first import if a DSN is configured, so errors that
// happen early still land upstream once the SDK loads.
if (SENTRY_DSN) initSentry()
