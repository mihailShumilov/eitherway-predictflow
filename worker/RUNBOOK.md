# PredictFlow keeper runbook

Operational reference for the Cloudflare Worker that owns the limit-order
lifecycle. Read this before touching production.

## Mental model

```
Browser ──HTTP──▶ Worker ──D1──▶ orders table
                    │           durable_nonces table
                    │           audit_log table (state log + metrics)
                    │
                    └─DO────▶ PriceWatcher (one per market with pending orders)
                                ├─ DFlow `prices` WebSocket subscription
                                ├─ trigger evaluation in-memory
                                └─ submitOrder() → Helius RPC → confirmation poll
```

The on-chain critical path is one `sendTransaction` JSON-RPC call to
Helius after a trigger crosses. Latency budget is dominated by the WS
tick interval from DFlow (sub-second) and the Solana confirmation time
(~1.5s with `confirmed` commitment).

## State machine

```
pending  ──trigger crosses──▶  armed
armed    ──submit starts───▶  submitting
submitting ──confirmed────▶  filled    (terminal)
submitting ──permanent err▶  failed    (terminal)
submitting ──transient err▶  armed     (retry on next eval)
pending  ──user cancels───▶  cancelled (terminal)
pending  ──nonce expires──▶  expired   (terminal — currently unreachable, durable nonce)
```

Status transitions are append-only in `audit_log`. The `metric.*` events
in audit_log are counters incremented at each transition.

## Common SQL queries

Inspect last hour of activity for a wallet:
```sql
SELECT ts, event, order_id, detail FROM audit_log
 WHERE wallet = '<pubkey>' AND ts > unixepoch('now', '-1 hour') * 1000
 ORDER BY ts DESC LIMIT 100;
```

Fill rate over the last 24h:
```sql
SELECT
  (SELECT count(*) FROM audit_log WHERE event = 'metric.order_filled' AND ts > unixepoch('now', '-1 day') * 1000) AS filled,
  (SELECT count(*) FROM audit_log WHERE event = 'metric.trigger_fired' AND ts > unixepoch('now', '-1 day') * 1000) AS triggered,
  (SELECT count(*) FROM audit_log WHERE event = 'metric.submit_failed_permanent' AND ts > unixepoch('now', '-1 day') * 1000) AS perm_failures;
```

WS health (disconnect rate by market):
```sql
SELECT json_extract(detail, '$.marketTicker') AS market, count(*) AS disconnects
  FROM audit_log
 WHERE event = 'metric.ws_disconnect' AND ts > unixepoch('now', '-1 hour') * 1000
 GROUP BY market ORDER BY disconnects DESC LIMIT 10;
```

Stuck submission queue (anything older than 5 min in non-terminal state):
```sql
SELECT id, wallet, market_ticker, status, updated_at FROM orders
 WHERE status IN ('armed', 'submitting') AND updated_at < unixepoch('now', '-5 minutes') * 1000;
```

Run via:
```bash
npm run db:console:remote -- "<paste SQL>"
```

## Incident response

### Symptom: orders stuck in `armed`

Likely cause: Helius RPC returned a transient error and we backed off, but
no PriceWatcher tick has re-evaluated. Either no further price ticks
arrived (paused market) or the DO crashed after the back-off.

Recovery: force a re-evaluation by waking the PriceWatcher.

```bash
# Find the affected market
npm run db:console:remote -- "SELECT DISTINCT market_ticker FROM orders WHERE status = 'armed'"

# Wake each one — replace the URL with your worker's URL
curl -X POST "https://predictflow-keeper-prod.<account>.workers.dev/_admin/wake?market=<TICKER>"
```

(The /_admin/wake endpoint is intentionally not implemented yet — add a
session-protected route under `routes/admin.ts` if you find yourself
needing it twice. Until then, placing any new order on the same market
will cause `routes/orders.ts` to fire `PRICE_WATCHER.fetch('/wake')` as
a side effect.)

### Symptom: orders stuck in `submitting`

The DO crashed mid-RPC-call. Helius may have actually accepted the tx —
verify before retrying:

```bash
# Get the tx hash from the most-recent submit attempt
npm run db:console:remote -- "SELECT id, fill_signature FROM orders WHERE status = 'submitting'"

# If fill_signature is null, the RPC didn't return one — safe to flip back to armed
npm run db:console:remote -- "UPDATE orders SET status = 'armed', updated_at = strftime('%s','now')*1000 WHERE id = '<id>'"
```

If `fill_signature` is non-null but status is still `submitting`, run:
```bash
curl https://api.mainnet-beta.solana.com -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[["<sig>"]]}'
```
and update the row to `filled` if it confirmed, `failed` if it errored.

### Symptom: WS disconnect storm

Look at recent `metric.ws_disconnect` events. If concentrated on one
market, that market's DO is in a bad reconnect loop — `wrangler tail`
will show the underlying error. Common cause: DFlow rate-limited us
because too many DO instances opened independent connections.
Mitigation: a single shared WS client across DOs (Phase 6+ enhancement).

Quick fix while investigating: bump the reconnect floor by editing
`RECONNECT_BASE_MS` in `lib/priceWatcher.ts` and redeploying.

### Symptom: a user reports their fill never happened

1. Check `audit_log` for the order id. Look for `trigger.fired` then
   either `order.filled` or any `submit.*_failure`.
2. If no `trigger.fired`: the price never crossed *or* the WS was never
   connected for that market. Confirm with `metric.ws_disconnect` —
   long gap = silent failure.
3. If `trigger.fired` but no `order.filled`: walk forward through the
   audit events. The most likely failures are `decrypt_failed` (bad
   SIGNED_TX_KEY rotation) or `tx_error:...` (on-chain rejection,
   often insufficient funds or stale nonce).

## Emergency stop

To halt all keeper-side execution immediately (e.g. during a security
incident), the cleanest lever is to revoke the deployed DFlow API key
upstream — the WS subscriptions all fail their next handshake and no
new triggers fire. Existing in-flight `submitting` rows complete or
time out within 60s.

Alternative (no DFlow rotation): mass-update orders to `cancelled`:
```sql
UPDATE orders SET status = 'cancelled', cancelled_at = strftime('%s','now')*1000
 WHERE status IN ('pending','armed');
```
This stops new fills cold; existing user-signed txs remain decryptable
but the keeper won't submit them.

## Key rotation

1. Generate a new key: `openssl rand -base64 32`.
2. Set as `SIGNED_TX_KEY_NEXT` (a separate secret).
3. Modify `lib/encryption.ts` to try the new key first, fall back to the
   old. (Not yet implemented — add when needed.)
4. Run a one-shot script that decrypts every row with the old key and
   re-encrypts with the new one.
5. Promote `SIGNED_TX_KEY_NEXT` to `SIGNED_TX_KEY`, remove the next-key.

This is destructive on failure — practice on preview first.

## Deploy checklist

- [ ] `npm test` passes locally
- [ ] `npx tsc --noEmit` clean
- [ ] All secrets present in target env (`wrangler secret list`)
- [ ] Migrations applied to target D1 (`npm run db:migrate:remote[:prod]`)
- [ ] DFlow API key valid (curl one of their endpoints with the key)
- [ ] Helius RPC URL reachable
- [ ] After deploy: `curl https://<worker-url>/health` returns ok
- [ ] After deploy: wake a known PriceWatcher and confirm it subscribes
      (check `wrangler tail` for the WS open log)

## Limits known to bite

- **D1 row count**: free plan is fine for personal use; if this grows,
  audit_log is the first table to outgrow. Add a retention policy
  (e.g. delete audit rows older than 90 days) before D1 limits hit.
- **DO storage size**: each PriceWatcher stores `marketTicker` and
  `lastPrice`. Tiny; not a concern.
- **Solana tx packet size**: 1232 bytes hard cap. The signed-tx
  enforcement in `routes/orders.ts` rejects anything over 1500. If
  legitimate orders bump against this, the DFlow tx itself is too
  large — open a ticket with DFlow.
- **Helius rate limits**: 10 RPS default on the Builder tier. Order
  submission is one call per fill; confirmation polling is one per
  ~1.5s for ~60s. A single fill burns ~40 calls. If you ever push
  past ~1 fill/second, upgrade Helius or batch confirmations.
