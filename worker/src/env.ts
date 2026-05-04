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

  // PredictFlow service commission. Both optional — if either is unset
  // (or COMMISSION_BPS=0), commission is skipped and the entire
  // post-DFlow residual is returned to the user instead.
  //
  //   COMMISSION_BPS               — basis points of amount_usdc taken as
  //                                   service fee on every successful fire.
  //                                   100 = 1.00%. Capped by available
  //                                   residual on the executor at fire time.
  //   COMMISSION_RECIPIENT_USDC_ATA — pre-derived USDC ATA owned by the
  //                                   PredictFlow treasury wallet. Pass the
  //                                   ATA (not the wallet) so the runtime
  //                                   doesn't need an extra RPC to derive it.
  COMMISSION_BPS?: string
  COMMISSION_RECIPIENT_USDC_ATA?: string

  // Secrets — set via `wrangler secret put NAME`
  SIGNED_TX_KEY: string         // base64-encoded 32-byte AES-256 key
  SESSION_SIGNING_KEY: string   // 32-byte HMAC key for session tokens
  DFLOW_API_KEY: string
  HELIUS_RPC_URL: string

  // Executor keypair (approval-flow). Base58-encoded 64-byte secret key
  // (Solana standard "secret key" format = priv|pub). The keeper signs
  // approval-flow swap transactions with this key. It IS a hot key, but
  // its on-chain authority is bounded by per-user spl-token approve
  // ceilings — see worker/src/lib/executor.ts for the exact trust model.
  EXECUTOR_SECRET_KEY: string

  // PostHog analytics. Optional — analytics is skipped when unset.
  POSTHOG_API_KEY?: string
  POSTHOG_HOST?: string
}

// Hono context variables we set in middleware so handlers don't have to
// re-derive them.
export type AppVariables = {
  wallet: string         // verified Solana pubkey from the session token
  sessionId: string
  requestId: string
}
