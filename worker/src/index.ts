// PredictFlow keeper — Cloudflare Worker entry.
//
// Exports:
//   - default fetch handler (Hono router)
//   - PriceWatcher Durable Object (Phase 3 fills it in; Phase 1 is a stub)
//
// Layering:
//   index → middleware (auth, request-id, cors) → routes (auth, orders)
//
// Deployment: see worker/README.md.

import { Hono } from 'hono'
import type { Env, AppVariables } from './env'
import authRoutes from './routes/auth'
import ordersRoutes from './routes/orders'
import noncesRoutes from './routes/durable-nonces'
import { requireSession } from './middleware/auth'
import { bytesToHex, randomBytes } from './lib/crypto'
import { parseAllowlist, matchAllowedOrigin } from './lib/origin'
import { getExecutorPubkey } from './lib/executor'
import { captureServerException } from './lib/posthog'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// CORS — only allow configured frontend origins. ALLOWED_ORIGIN may be a
// single value or a comma-separated allowlist (e.g. preview + prod + local
// dev). The credentials flag is false by default since we use Authorization
// headers, not cookies, so browsers don't need to pre-flight credentials.
app.use('*', async (c, next) => {
  const allowList = parseAllowlist(c.env.ALLOWED_ORIGIN)
  const matched = matchAllowedOrigin(c.req.header('origin'), allowList)
  if (matched) {
    c.header('access-control-allow-origin', matched)
    c.header('vary', 'origin')
  }
  c.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
  c.header(
    'access-control-allow-headers',
    'authorization,content-type,x-request-id',
  )
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// Per-request id, propagated to audit log + response header. Use the
// client-provided x-request-id if present (helps cross-tier debugging),
// otherwise mint a fresh one.
app.use('*', async (c, next) => {
  const reqId = c.req.header('x-request-id') ?? bytesToHex(randomBytes(8))
  c.set('requestId', reqId)
  c.header('x-request-id', reqId)
  await next()
})

app.get('/health', (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, time: Date.now() }),
)

// Public executor pubkey — the delegate that frontends pass to spl-token
// `approve` when building approval-flow orders. Returned on /config so the
// browser doesn't have to know about it via env, and rotations propagate
// to clients without redeploys.
app.get('/config', (c) => {
  let executor: string | null = null
  try {
    executor = getExecutorPubkey(c.env)
  } catch (err) {
    console.error('executor_unavailable', { error: String(err) })
  }
  return c.json({ executor })
})

app.route('/auth', authRoutes)
app.use('/orders/*', requireSession)
app.use('/durable-nonces/*', requireSession)
app.route('/orders', ordersRoutes)
app.route('/durable-nonces', noncesRoutes)

app.notFound((c) =>
  c.json({ error: 'not_found', requestId: c.var.requestId }, 404),
)
app.onError((err, c) => {
  console.error('unhandled', { error: String(err), stack: err.stack, requestId: c.var.requestId })
  // Forward to PostHog as a $exception so error analytics can surface
  // unhandled route failures alongside client-side ones. Best-effort:
  // the wallet may not be in scope here (auth route or pre-auth path).
  c.executionCtx.waitUntil(
    captureServerException(c.env, c.var.wallet ?? 'system', err, {
      request_id: c.var.requestId,
      path: c.req.path,
      method: c.req.method,
    }),
  )
  return c.json({ error: 'internal_error', requestId: c.var.requestId }, 500)
})

export default app

// PriceWatcher Durable Object — owns the DFlow `prices` WS subscription
// for one market and evaluates triggers in real time. See lib/priceWatcher.ts.
export { PriceWatcher } from './lib/priceWatcher'
