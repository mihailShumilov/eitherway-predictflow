// Tiny fetch wrapper with retry + backoff. Keeps dependencies zero.
// Use for any non-interactive API call where a transient 5xx or network
// blip shouldn't surface as a user-visible failure.

const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 400
const DEFAULT_TIMEOUT_MS = 10000

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms))
}

function isRetryable(err) {
  if (err?.name === 'AbortError') return false
  if (err instanceof TypeError) return true // network / CORS
  if (err?.status && err.status >= 500) return true
  return false
}

export async function fetchWithRetry(url, opts = {}, config = {}) {
  const {
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryOn = [408, 425, 429, 500, 502, 503, 504],
  } = config

  let lastErr

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...opts, signal: opts.signal || controller.signal })
      clearTimeout(timer)
      if (!res.ok && retryOn.includes(res.status) && attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      if (!isRetryable(err) || attempt === retries) throw err
      await sleep(backoffMs * Math.pow(2, attempt))
    }
  }
  throw lastErr || new Error('fetchWithRetry exhausted')
}

export async function fetchJson(url, opts, config) {
  const res = await fetchWithRetry(url, opts, config)
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export function generateIdempotencyKey(prefix = 'req') {
  // Require CSPRNG. `Math.random` was previously used as a fallback but
  // idempotency keys that collide invite replay/spoofing, so refuse to
  // fabricate a weak one — every browser we target has crypto.randomUUID.
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('crypto.randomUUID unavailable — refusing to generate weak idempotency key')
  }
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}
