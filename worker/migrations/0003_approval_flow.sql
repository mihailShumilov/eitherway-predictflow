-- Approval-based execution flow.
--
-- Adds support for orders where the user signs an spl-token `approve` once
-- at placement and the keeper's executor key signs the actual swap at fire
-- time. Avoids Phantom's Lighthouse / Smart-Transactions wrapper which
-- prepends instructions ahead of `advanceNonceAccount` and breaks Solana's
-- durable-nonce position-0 invariant.
--
-- Coexistence: existing rows are backfilled with flow='durable_nonce_legacy'.

-- D1 / SQLite can't drop NOT NULL constraints in-place, and the original
-- orders table required signed_tx_enc/iv to be NOT NULL. Rebuild the table
-- with relaxed constraints + the new approval-flow columns. Indexes are
-- recreated identically.
CREATE TABLE orders_new (
  id              TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL,
  market_ticker   TEXT NOT NULL,
  market_id       TEXT,
  event_ticker    TEXT,
  side            TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  order_type      TEXT NOT NULL CHECK (order_type IN ('limit', 'stop-loss', 'take-profit')),
  trigger_price   REAL NOT NULL,
  amount_usdc     REAL NOT NULL,
  yes_mint        TEXT,
  no_mint         TEXT,

  -- Nullable for flow='approval' (no user-signed swap tx).
  signed_tx_enc       BLOB,
  signed_tx_iv        BLOB,
  durable_nonce       TEXT,
  durable_nonce_value TEXT,

  flow                          TEXT NOT NULL DEFAULT 'durable_nonce_legacy'
                                   CHECK (flow IN ('durable_nonce_legacy', 'approval')),
  approval_signature            TEXT,
  delegated_amount_at_placement INTEGER,
  user_input_ata                TEXT,
  output_mint                   TEXT,
  input_mint                    TEXT,

  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','armed','submitting','filled','failed','cancelled','expired')),
  failure_reason  TEXT,
  fill_signature  TEXT,
  fill_price      REAL,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  triggered_at    INTEGER,
  filled_at       INTEGER,
  cancelled_at    INTEGER
);

INSERT INTO orders_new (
  id, wallet, market_ticker, market_id, event_ticker, side, order_type,
  trigger_price, amount_usdc, yes_mint, no_mint,
  signed_tx_enc, signed_tx_iv, durable_nonce, durable_nonce_value,
  flow, approval_signature, delegated_amount_at_placement,
  user_input_ata, output_mint, input_mint,
  status, failure_reason, fill_signature, fill_price,
  created_at, updated_at, triggered_at, filled_at, cancelled_at
)
SELECT
  id, wallet, market_ticker, market_id, event_ticker, side, order_type,
  trigger_price, amount_usdc, yes_mint, no_mint,
  signed_tx_enc, signed_tx_iv, durable_nonce, durable_nonce_value,
  'durable_nonce_legacy', NULL, NULL,
  NULL, NULL, NULL,
  status, failure_reason, fill_signature, fill_price,
  created_at, updated_at, triggered_at, filled_at, cancelled_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX idx_orders_wallet_status ON orders(wallet, status);
CREATE INDEX idx_orders_status_market ON orders(status, market_ticker) WHERE status IN ('pending','armed');
CREATE INDEX idx_orders_market_pending ON orders(market_ticker) WHERE status = 'pending';
CREATE INDEX idx_orders_updated_at ON orders(updated_at);
CREATE INDEX idx_orders_flow ON orders(flow);

-- Approval-flow ledger. One row per spl-token approve event we received from
-- the frontend. Source of authority at fire time is the on-chain
-- delegated_amount; this table records intent for audit and dispute.
CREATE TABLE token_approvals (
  signature       TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL,
  token_account   TEXT NOT NULL,
  mint            TEXT NOT NULL,
  delegate        TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_token_approvals_wallet ON token_approvals(wallet);
CREATE INDEX idx_token_approvals_account ON token_approvals(token_account);
