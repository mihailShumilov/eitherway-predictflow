// PostHog analytics client for the keeper Worker.
//
// Cloudflare Workers is a short-lived edge runtime — every request handler
// is a new isolate. We therefore:
//   1. Create one PostHog instance per request (no singleton state leaks).
//   2. Always use captureImmediate / identifyImmediate so events are flushed
//      before the isolate exits, without needing shutdown().
//   3. Skip initialisation entirely when POSTHOG_API_KEY is unset so
//      analytics never block or crash the critical path.
//
// All worker events use the wallet pubkey as `distinctId` so server-side and
// client-side events share the same PostHog person.

import { PostHog } from 'posthog-node'
import type { Env } from '../env'

export function makePostHog(env: Env): PostHog | null {
  if (!env.POSTHOG_API_KEY) return null
  return new PostHog(env.POSTHOG_API_KEY, {
    host: env.POSTHOG_HOST,
    // Batch sending is irrelevant in edge; disable to keep memory footprint minimal.
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: false,
  })
}

// Fire-and-forget capture helper. Never throws — analytics failures must
// not block the order pipeline. `distinctId` should be the wallet pubkey
// for any user-attributable event; pass `'system'` for background tasks
// (alarms, reapers) that don't have a wallet in scope.
export async function capturePh(
  env: Env,
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const ph = makePostHog(env)
  if (!ph) return
  try {
    await ph.captureImmediate({
      distinctId,
      event,
      properties: { environment: env.ENVIRONMENT, ...properties },
    })
  } catch (err) {
    console.error('posthog_capture_failed', { event, error: String(err) })
  }
}

// Identify wallet + merge wallet_address person property. Use this on
// session mint and any other point where you learn something new about the
// user (KYC status, tier, etc.).
export async function identifyWallet(
  env: Env,
  wallet: string,
  setProperties: Record<string, unknown> = {},
): Promise<void> {
  const ph = makePostHog(env)
  if (!ph) return
  try {
    ph.identify({
      distinctId: wallet,
      properties: {
        $set: {
          wallet_address: wallet,
          network: env.SOLANA_NETWORK,
          environment: env.ENVIRONMENT,
          ...setProperties,
        },
      },
    })
  } catch (err) {
    console.error('posthog_identify_failed', { error: String(err) })
  }
}

// Forward a caught server-side exception to PostHog. Used at route boundaries
// (onError handler) and from any try/catch that wants to keep an error trail.
export async function captureServerException(
  env: Env,
  distinctId: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err))
  await capturePh(env, distinctId, '$exception', {
    $exception_type: e.name || 'Error',
    $exception_message: e.message,
    $exception_stack_trace_raw: e.stack,
    ...context,
  })
}
