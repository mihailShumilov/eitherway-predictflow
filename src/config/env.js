// Centralized environment configuration. Reads Vite-exposed vars from
// import.meta.env and falls back to sensible defaults so the app still
// works without a .env file — defaults match the current dev setup.
//
// To override any value, create a `.env.local` (gitignored) with the
// VITE_* key. See `.env.example` for the full surface.

const env = import.meta.env || {}

function str(key, fallback) {
  const v = env[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function bool(key, fallback = false) {
  const v = env[key]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

function list(key, fallback) {
  const v = env[key]
  if (!v) return fallback
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

// Same-origin paths (e.g. `/api/rpc`) need to be expanded to an absolute
// URL because `new Connection()` (and other web3.js consumers) parse the
// endpoint with `new URL(endpoint)` which rejects relative paths.
function absolutize(url) {
  if (!url) return url
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url  // already absolute (http, https, ws, wss, ...)
  if (typeof window !== 'undefined' && window.location) {
    return new URL(url, window.location.origin).toString()
  }
  return url
}

export const IS_DEV = !!env.DEV
export const IS_PROD = !!env.PROD
export const MODE = env.MODE || 'development'

// DFlow — defaults are same-origin proxy paths so the browser bundle never
// needs to know the upstream host or carry an API key. The Cloudflare Pages
// Functions in `functions/api/` add the DFLOW_API_KEY header server-side.
// In Vite dev, `vite.config.js` proxies these to the dev-cluster hosts.
export const DFLOW_PROXY_BASE = str('VITE_DFLOW_PROXY_BASE', '/api/dflow')
export const DFLOW_QUOTE_URL = str('VITE_DFLOW_QUOTE_URL', '/api/dflow-quote')
export const DFLOW_ORDER_URL = str('VITE_DFLOW_ORDER_URL', '/api/dflow-order')
// DFlow real-time channels. The dev endpoint is auth-free (rate-limited but
// fine for personal-use volume); the prod endpoint requires `x-api-key` on
// the HTTP upgrade, which browsers cannot set — a CF Pages Function proxy
// would be needed to use it from this bundle. Default to dev for now.
export const DFLOW_WS_URL = str('VITE_DFLOW_WS_URL', 'wss://dev-prediction-markets-api.dflow.net/api/v1/ws')
export const DFLOW_DOCS_URL = str('VITE_DFLOW_DOCS_URL', 'https://docs.dflow.net')
export const DFLOW_ALLOWED_PROGRAMS = list('VITE_DFLOW_ALLOWED_PROGRAMS', [])

// Solana
export const SOLANA_NETWORK = str('VITE_SOLANA_NETWORK', 'mainnet')
export const SOLANA_RPC_ENDPOINTS = list('VITE_SOLANA_RPC_ENDPOINTS', [
  'https://api.devnet.solana.com',
  'https://api.mainnet-beta.solana.com',
]).map(absolutize)
export const USDC_MINT = str('VITE_USDC_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const SPL_TOKEN_PROGRAM = str('VITE_SPL_TOKEN_PROGRAM', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

// KYC / Proof
export const PROOF_URL = str('VITE_PROOF_URL', 'https://www.dflow.net/proof')
export const KYC_CHECK_URL = str('VITE_KYC_CHECK_URL', '') // empty = self-attestation

// Observability
export const SENTRY_DSN = str('VITE_SENTRY_DSN', '')
export const ANALYTICS_PROVIDER = str('VITE_ANALYTICS_PROVIDER', '') // '', 'posthog', 'plausible', 'custom'
export const ANALYTICS_WRITE_KEY = str('VITE_ANALYTICS_WRITE_KEY', '')
export const ANALYTICS_HOST = str('VITE_ANALYTICS_HOST', '')

// Safety flags — default OFF in prod, ON in dev.
// - synthesized mints: fake YES-/NO- mint strings when DFlow doesn't publish real ones
// - simulated fills:    pretend an order filled if DFlow /order fails
// Both are unsafe for real money and must be explicitly enabled by env if you really want them in prod.
export const ALLOW_SYNTHESIZED_MINTS = bool('VITE_ALLOW_SYNTHESIZED_MINTS', IS_DEV)
export const ALLOW_SIMULATED_FILLS = bool('VITE_ALLOW_SIMULATED_FILLS', IS_DEV)

// Live-feed endpoint (if DFlow publishes one). Falls back to stub polling.
export const LIVE_PRICE_URL = str('VITE_LIVE_PRICE_URL', '')

// Keeper Worker base URL — the production limit-order backend. When unset
// the frontend falls back to the legacy localStorage trigger loop so the
// app remains usable in dev environments without a deployed keeper.
export const KEEPER_API_BASE = str('VITE_KEEPER_API_BASE', '')

// Solana RPC URL the frontend uses for read-only nonce-account ops + the
// occasional balance check. Defaults to the first endpoint in
// SOLANA_RPC_ENDPOINTS so we don't need a separate env var in dev.
export const SOLANA_RPC_URL = absolutize(str('VITE_SOLANA_RPC_URL', ''))

// Legal / contact
export const TERMS_URL = str('VITE_TERMS_URL', '')
export const PRIVACY_URL = str('VITE_PRIVACY_URL', '')
export const RISK_URL = str('VITE_RISK_URL', '')
export const SUPPORT_EMAIL = str('VITE_SUPPORT_EMAIL', '')

export default {
  IS_DEV,
  IS_PROD,
  MODE,
  DFLOW_PROXY_BASE,
  DFLOW_QUOTE_URL,
  DFLOW_ORDER_URL,
  DFLOW_WS_URL,
  DFLOW_DOCS_URL,
  SOLANA_NETWORK,
  SOLANA_RPC_ENDPOINTS,
  USDC_MINT,
  SPL_TOKEN_PROGRAM,
  PROOF_URL,
  KYC_CHECK_URL,
  SENTRY_DSN,
  ANALYTICS_PROVIDER,
  ANALYTICS_WRITE_KEY,
  ANALYTICS_HOST,
  ALLOW_SYNTHESIZED_MINTS,
  ALLOW_SIMULATED_FILLS,
  LIVE_PRICE_URL,
  TERMS_URL,
  PRIVACY_URL,
  RISK_URL,
  SUPPORT_EMAIL,
}
