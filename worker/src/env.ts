// Bindings + secrets surfaced to every Worker handler. Keep this in sync
// with wrangler.toml (vars + secrets) and the DO bindings.

export type Env = {
  // Bindings
  DB: D1Database
  PRICE_WATCHER: DurableObjectNamespace

  // Public vars
  ENVIRONMENT: 'preview' | 'production'
  DFLOW_REST_BASE: string
  DFLOW_TRADE_BASE: string
  DFLOW_WS_URL: string
  SOLANA_NETWORK: 'mainnet' | 'devnet'
  USDC_MINT: string
  ALLOWED_ORIGIN: string
  SESSION_TTL_SECONDS: string

  // Secrets — set via `wrangler secret put NAME`
  SIGNED_TX_KEY: string         // base64-encoded 32-byte AES-256 key
  SESSION_SIGNING_KEY: string   // 32-byte HMAC key for session tokens
  DFLOW_API_KEY: string
  HELIUS_RPC_URL: string
}

// Hono context variables we set in middleware so handlers don't have to
// re-derive them.
export type AppVariables = {
  wallet: string         // verified Solana pubkey from the session token
  sessionId: string
  requestId: string
}
