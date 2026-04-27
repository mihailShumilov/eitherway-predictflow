-- PredictFlow keeper — initial schema.
--
-- All tables are owner-scoped by `wallet` (base58 Solana pubkey). Every query
-- in routes/orders.ts MUST include a wallet predicate; routes/auth.ts is
-- responsible for binding the session to a verified wallet.

-- One row per Sign-in-with-Solana session. Token is HMAC-signed (see
-- lib/session.ts) so we don't need to look up by token on every request,
-- but we keep the table to support revocation and audit.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  wallet        TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_wallet ON sessions(wallet);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Short-lived auth challenges issued by /auth/challenge.
-- Used once and then deleted (see lib/solana-auth.ts).
CREATE TABLE auth_challenges (
  nonce         TEXT PRIMARY KEY,
  wallet        TEXT NOT NULL,
  message       TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_auth_challenges_expires_at ON auth_challenges(expires_at);

-- Conditional orders. The state machine:
--   pending  — waiting for trigger
--   armed    — trigger evaluator picked it up; about to submit
--   submitting — sendRawTransaction in flight
--   filled   — transaction confirmed
--   failed   — permanent failure (insufficient funds, KYC, decode error)
--   cancelled — user cancelled before fill
--   expired  — durable nonce / blockhash expired without fill
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,         -- uuid generated client-side or server-side
  wallet          TEXT NOT NULL,
  market_ticker   TEXT NOT NULL,            -- DFlow market ticker (the source of truth — NOT marketId)
  market_id       TEXT,                     -- our display-only id, may be synthesized
  event_ticker    TEXT,
  side            TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  order_type      TEXT NOT NULL CHECK (order_type IN ('limit', 'stop-loss', 'take-profit')),
  trigger_price   REAL NOT NULL,            -- 0..1
  amount_usdc     REAL NOT NULL,            -- input USDC, decimal
  -- Mints captured at placement time so the keeper doesn't need to re-resolve
  -- via /markets/by-ticker on every fill attempt. Backfilled if missing.
  yes_mint        TEXT,
  no_mint         TEXT,

  -- Encrypted Solana transaction blob, base64. AES-256-GCM with key from
  -- Worker secret SIGNED_TX_KEY. Format: nonce(12) || ciphertext || tag.
  signed_tx_enc       BLOB NOT NULL,
  signed_tx_iv        BLOB NOT NULL,        -- 12-byte AES-GCM nonce, stored separately for clarity
  -- Durable nonce account this order's tx is bound to. The keeper must
  -- advance this nonce after a successful fill (or the user does it lazily
  -- next time). Nullable for v1 stub orders that don't yet use nonce.
  durable_nonce       TEXT,
  durable_nonce_value TEXT,                  -- the actual nonce bytes baked into the tx (base58)

  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','armed','submitting','filled','failed','cancelled','expired')),
  failure_reason  TEXT,                     -- populated when status = failed/expired
  fill_signature  TEXT,                     -- on-chain signature when filled
  fill_price      REAL,                     -- price at fill, 0..1

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  triggered_at    INTEGER,                  -- when the price first crossed the trigger
  filled_at       INTEGER,
  cancelled_at    INTEGER
);
CREATE INDEX idx_orders_wallet_status ON orders(wallet, status);
CREATE INDEX idx_orders_status_market ON orders(status, market_ticker) WHERE status IN ('pending','armed');
CREATE INDEX idx_orders_market_pending ON orders(market_ticker) WHERE status = 'pending';
CREATE INDEX idx_orders_updated_at ON orders(updated_at);

-- One durable nonce account per (wallet, market) pair, lazily created. Storing
-- here lets us reuse the same nonce account across an order's lifetime
-- (advance after each fill) instead of paying rent for a new account every
-- order. The actual on-chain account is owned by the user's wallet — we just
-- record its address + the latest known nonce value.
CREATE TABLE durable_nonces (
  pubkey          TEXT PRIMARY KEY,         -- nonce account pubkey
  wallet          TEXT NOT NULL,
  market_ticker   TEXT NOT NULL,
  current_nonce   TEXT NOT NULL,            -- latest known nonce value, base58
  last_seen_slot  INTEGER,                  -- removed in 0002; kept here for migration replay
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_durable_nonces_wallet_market ON durable_nonces(wallet, market_ticker);

-- Append-only audit log. Every state transition + every keeper decision lands
-- here. Used for debugging, support, and post-incident review. Never delete.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  wallet      TEXT,                         -- nullable for system events
  order_id    TEXT,
  event       TEXT NOT NULL,                -- e.g. 'order.created', 'trigger.fired', 'submit.failed'
  detail      TEXT,                         -- JSON-serialized payload
  request_id  TEXT
);
CREATE INDEX idx_audit_log_order_id ON audit_log(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_audit_log_wallet_ts ON audit_log(wallet, ts) WHERE wallet IS NOT NULL;
CREATE INDEX idx_audit_log_ts ON audit_log(ts);
