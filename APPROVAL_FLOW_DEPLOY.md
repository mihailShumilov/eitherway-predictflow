# Approval-flow deploy runbook

Step-by-step to roll out the new approval-flow architecture (which makes Phantom work for limit orders) without losing any in-flight legacy-flow orders.

## What changed

- **New flow**: limit / stop-loss / take-profit orders no longer require the user to sign the swap. The user signs an `spl-token approve` (one-shot, regular blockhash, immune to wallet Lighthouse injection) delegating up to the relevant atomic amount on the input mint to a keeper-controlled executor pubkey. At trigger time the keeper builds + signs + submits the swap server-side.
- **Direction matrix**:
  - `limit` (BUY): user approves USDC → keeper swaps USDC for outcome tokens, delivered to user via DFlow `destinationWallet`.
  - `stop-loss` / `take-profit` (SELL): user approves the outcome token → keeper swaps outcome for USDC, delivered to user via DFlow `destinationWallet`.
- **Coexistence**: existing in-flight orders stay on the legacy durable-nonce flow (`flow='durable_nonce_legacy'`). New orders go to `flow='approval'` regardless of order type.
- **Custody**: the keeper now holds an executor private key. It is bounded per-user per-token-account by the on-chain `delegated_amount` on each ATA the user has approved (USDC, plus any outcome-token mints they've stop-lossed). Users can `revoke` at any time from the Active Orders panel; the revoke UI accepts a list of mints to wipe.
- **DCA**: not changed by this rollout. DCA continues to fire one market trade per scheduled tick from the user's wallet directly. It has always worked on Phantom because each tick is a regular blockhash tx (no durable nonce, no instruction-position-0 invariant for Lighthouse to break). The constraint is unchanged: DCA only fires while the user's tab is open. Moving DCA to keeper-managed multi-fill is a separate larger feature (see "Follow-ups" below).

## Test locally before deploy

The local stack runs the keeper on `wrangler dev` (port 8787) against a local D1 instance, and the frontend on `vite dev` (port 5173). DFlow + Helius are still hit live on mainnet — there is no testnet for DFlow's prediction-markets `/order` endpoint, so any order that fires will execute a real on-chain swap. Use tiny amounts ($0.05–$0.10) and trigger prices far from the current market to avoid accidental fills during smoke tests.

### Prerequisites

- Two browser wallets (Phantom + Solflare) with each containing ~$1 USDC and ~0.005 SOL on mainnet for fees.
- Wrangler logged in: `wrangler login` (only needed once).
- A separate dev executor keypair (do NOT reuse the production executor for local tests).

### One-time setup

1. **Generate a dedicated dev executor**:
   ```
   cd worker
   node scripts/generate-executor-key.mjs
   # → prints dev pubkey, writes ./executor-secret.txt (mode 0600)
   ```

2. **Verify the dev executor at DFlow**: visit https://dflow.net/proof and complete Proof for the dev pubkey. Same procedure as production. Without this, every fire will fail with `dflow_rejected`.

3. **Fund the dev executor**: send ~0.005 SOL to the dev pubkey on mainnet (rent for one durable-nonce account + a handful of swap fees is enough for an end-to-end test).

4. **Set the secret for `wrangler dev`** — it reads from `.dev.vars` (gitignored), not from the wrangler-managed secret store:
   ```
   echo "EXECUTOR_SECRET_KEY=$(cat executor-secret.txt)" >> .dev.vars
   shred -u executor-secret.txt
   ```
   `.dev.vars` should also already contain `SIGNED_TX_KEY`, `SESSION_SIGNING_KEY`, `DFLOW_API_KEY`, `HELIUS_RPC_URL`. Confirm those are present too.

5. **Apply migrations to local D1**:
   ```
   npm run db:migrate:local
   # verify
   wrangler d1 execute predictflow --local --command \
     "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   # → should list orders, token_approvals, durable_nonces, sessions, audit_log
   ```

### Run the dev stack

Two terminals:

```
# terminal 1 — keeper
cd worker
npm run dev          # → http://localhost:8787
npm run tail         # → live structured logs (separate pane is handy)

# terminal 2 — frontend
cd ..
VITE_KEEPER_API_BASE=http://localhost:8787 npm run dev   # → http://localhost:5173
```

### Smoke tests (no money at risk)

1. **/config returns the dev executor**:
   ```
   curl http://localhost:8787/config
   # → { "executor": "<your dev pubkey>" }
   ```

2. **Frontend resolves /config**: open http://localhost:5173, open DevTools → Network. Connect Phantom; you should see one GET `/config` and the response payload should match step 1.

3. **Worker tests**:
   ```
   cd worker
   npm test           # → 63 passing
   npm run typecheck  # → exit 0
   ```

4. **Frontend tests + build**:
   ```
   cd ..
   npm test           # → 151 passing
   npm run build      # → exit 0, bundles emitted to dist/
   ```

### End-to-end fire test (real swap, real fees)

Pick a market with active price movement. Use a trigger price intentionally close to the current ask so the order fires within seconds.

1. Connect Phantom on http://localhost:5173.
2. Place a **$0.05 limit BUY** with trigger ≈ current ask + 0.5¢.
3. Expected wallet popup: a single "Approve" tx (no swap details). Confirm.
4. The Active Orders panel shows the row with `delegated` badge and status `pending`.
5. Watch the keeper tail:
   ```
   approval_submit_attempt   { id, marketTicker, txBytes }
   approval_submit_broadcast { id, signature }
   order_filled              { id, signature }
   ```
6. Verify the fill on Solscan via the signature; the destination wallet should be your Phantom address (DFlow `destinationWallet`).

Run the same test with **Solflare** to confirm wallet-agnosticism. Both wallets should see exactly one approve popup and no swap-tx popup.

### Approval-flow regression tests (no swap, fast)

Tests that exercise placement + cancellation paths without firing a swap:

1. **Trigger far from market** — place a limit BUY at trigger 0.01 (well below ask). The order stays `pending`. Confirm Active Orders shows the `delegated` badge. Cancel from the UI; the row flips to `cancelled` (no tx broadcast).

2. **Duplicate-order rejection** — try to place a second order on the same market while one is non-terminal. The keeper should respond 409 `duplicate_pending_order`.

3. **Direction matrix rejection (manual)** — POST a malformed body with `flow=approval, orderType=limit, inputMint=<outcome>, outputMint=USDC` (i.e. swapped). Expected 400 `validation_failed` with detail mentioning `inputMint mismatch`:
   ```
   curl -X POST http://localhost:8787/orders \
     -H "authorization: Bearer <session-token-from-DevTools>" \
     -H "content-type: application/json" \
     -d '{ "flow":"approval", "marketTicker":"...", "side":"yes",
           "orderType":"limit", "triggerPrice":0.5, "amountUsdc":0.05,
           "yesMint":"...", "noMint":"...",
           "approvalSignature":"<88-char base58>",
           "delegatedAmountAtPlacement":50000,
           "userInputAta":"<some pubkey>",
           "inputMint":"<outcome mint>",
           "outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }'
   ```

4. **ATA-spoof rejection (manual)** — same as above but with `userInputAta` set to a pubkey that is NOT `getAssociatedTokenAddressSync(USDC, <wallet>)`. Expected 400 with detail `userInputAta does not match wallet+inputMint ATA`. This is the load-bearing CRIT-1 fix; verify it returns 400 in the local env before deploying.

5. **Revoke wipes delegation + cancels orders** — place an order, then click "Revoke approval" in the Active Orders panel. Expected sequence:
   ```
   POST /orders/cancel-by-mint   → { cancelled: 1, mints: [USDC_MINT] }
   <on-chain spl-token revoke>
   ```
   Active Orders should flip the row to `cancelled` immediately. The on-chain delegation on the user's USDC ATA goes to zero (verify with `wrangler d1 execute predictflow --local --command "SELECT status FROM orders WHERE id='<id>'"` and a Solana explorer lookup of the ATA).

### Tail-watching reference

Useful log lines to grep for during local testing:

| Log key                            | Meaning                                                        |
| ---                                | ---                                                            |
| `executor_unavailable`             | EXECUTOR_SECRET_KEY missing/invalid in `.dev.vars`             |
| `approval_submit_attempt`          | Trigger fired, building swap tx                                 |
| `approval_submit_broadcast`        | Tx sent to Helius, awaiting confirmation                        |
| `approval_submit_send_failed`      | Helius rejected; check `permanent` flag and error code          |
| `order_failed` with `code=ata_invalid` | On-chain ATA owner/mint mismatch — DB drift or attack attempt |
| `order_failed` with `code=delegate_mismatch` | User revoked between placement and fire                  |
| `order_failed` with `code=delegation_insufficient` | Atomic underflow (compute_input_atomic disagrees with what was approved) |
| `executor_nonce_warm_failed`       | Background nonce-account creation failed (non-fatal; submit will retry) |
| `nonce_claim_lost_but_no_winner`   | Race-safe nonce claim hit an inconsistent state — investigate   |

### Cleanup after local tests

```
# Drop the dev executor's funds back to your hot wallet
solana transfer --from /tmp/dev-executor.json <your-wallet> ALL

# Wipe the local DB (optional — useful when iterating on schema)
rm -rf worker/.wrangler/state/v3/d1
npm --prefix worker run db:migrate:local
```

---

## Pre-deploy checklist

1. **Generate the executor keypair** (default mode writes the secret to a 0600 file so it never lands in shell history / scrollback / CI logs):
   ```
   cd worker
   node scripts/generate-executor-key.mjs
   # → prints pubkey, writes ./executor-secret.txt (mode 0600)
   ```
   Or pipe directly into `wrangler` so the secret never touches disk:
   ```
   node scripts/generate-executor-key.mjs --pipe | wrangler secret put EXECUTOR_SECRET_KEY --env production
   ```
   Save the pubkey (public) and put one offline backup of the secret in a sealed location. After step 2 below, `shred -u executor-secret.txt`. Do NOT commit either to the repo.

2. **Verify the executor pubkey at DFlow**: visit https://dflow.net/proof and complete Proof verification for the pubkey. DFlow requires the `userPublicKey` on `/order` to be verified, even though the outcome token is delivered to a different (also-verified) wallet via `destinationWallet`.

3. **Fund the executor**: send ~0.01 SOL to the executor pubkey on mainnet. Required for tx fees + ~0.0015 SOL per durable-nonce account (one per market the keeper has handled). The keeper will lazily create more nonce accounts as orders are placed for new markets.

## Deploy steps

1. **Set the worker secret**:
   ```
   cd worker
   wrangler secret put EXECUTOR_SECRET_KEY --env production
   # paste the base58 secret from step 1 above
   ```

2. **Apply the D1 migration** (additive — adds columns, recreates the orders table to relax NOT NULL on `signed_tx_enc`/`signed_tx_iv`, adds `token_approvals` table):
   ```
   wrangler d1 migrations apply predictflow --remote --env production
   ```
   The migration backfills existing rows with `flow='durable_nonce_legacy'`. Verify post-migration:
   ```
   wrangler d1 execute predictflow --remote --env production --command \
     "SELECT flow, COUNT(*) FROM orders GROUP BY flow"
   ```

3. **Deploy the worker**:
   ```
   npm run deploy:prod
   ```

4. **Smoke-test the new endpoint**:
   ```
   curl https://api.predictflow.org/config
   # → { "executor": "<your executor pubkey>" }
   ```
   Confirm the pubkey matches the one you generated.

5. **Rebuild + redeploy the frontend** (root):
   ```
   cd ..
   npm run build
   # then push dist/ via your existing Cloudflare Pages flow
   ```

## Post-deploy validation

1. With Phantom:
   - Connect on `app.predictflow.org`
   - Place a small limit order (e.g. $0.10).
   - Expected: ONE wallet popup that says "Approve [amount] USDC" (no swap details).
   - After confirmation, the order shows in Active Orders with a `delegated` badge.
   - When the trigger crosses, the swap should land within ~30s. Watch `wrangler tail --env production` for `approval_submit_attempt` → `approval_submit_broadcast` → confirmation. Solscan should show the tx.

2. With Solflare:
   - Same flow as above. Should also work — Solflare has no Lighthouse injection but the approval flow is wallet-agnostic.

3. Stop-loss / take-profit:
   - Still use legacy flow. Will not work on Phantom. Either disable those types in the UI for Phantom or extend the approval flow to outcome-token approves (follow-up work).

## Rollback

If something goes wrong:

1. Revert the worker:
   ```
   wrangler deployments list --env production
   wrangler rollback <prior version id> --env production
   ```
2. Revert the frontend by redeploying the prior `dist/` build.
3. The migration is forward-compatible — leaving it applied while running the prior worker is safe (legacy code paths ignore the new columns).

## Known limitations

- Outcome tokens (and USDC for sells) are delivered to `destinationWallet=user` directly by DFlow. If DFlow ever changes that semantics, the keeper will need a final transfer instruction. The submitter's tx-byte budget already has headroom for that.
- The executor pubkey must remain DFlow Proof-verified. Mass account checks (KYC re-verifications) could affect ALL keeper-managed orders if the executor's status flips. Watch DFlow's KYC notifications.
- Compromise of `EXECUTOR_SECRET_KEY` lets an attacker spend up to the sum of active per-user delegations across all approved mints. Rotate by: (a) cancel all in-flight orders, (b) send a notification asking users to revoke, (c) generate + deploy new executor, (d) users approve the new pubkey on next order placement.
- **DCA is session-bound**: orders only fire while the user's tab is open. The user signs each buy individually (small wallet popup per tick). Works on Phantom + Solflare today; not affected by this rollout.

## Follow-ups (not in this rollout)

- **Keeper-managed DCA**: extend the approval flow so a single approve covers a recurring schedule. Each scheduled fill becomes a row with `flow='approval', status='scheduled', schedule_at=<ts>`. The PriceWatcher DO (or a new TimeWatcher DO) wakes on schedule_at and arms the row. User signs once, fills run in the background even with the tab closed. Architecture and trust model are identical to the limit flow; the work is in the scheduler + a per-tick budget tracker (so a single approval pool spans N scheduled buys).
- **Multi-mint approval bundling**: on first order placement we currently emit one `approve` per inputMint. If a user places (limit BUY USDC) and (stop-loss SELL outcome) back-to-back, that's two wallet popups. We could bundle both `approve`s into a single tx so the user sees one popup. Worth doing once we see real usage of mixed-direction order pairs.
- **Sweep of orphaned executor token accounts**: if the keeper accumulates dust in its executor ATAs (e.g. rounding remainders), add a periodic sweep job. None of the current code path leaves a balance behind, but worth wiring up before real volume.

## Files touched in this change

Worker:
- `worker/migrations/0003_approval_flow.sql` (new)
- `worker/src/env.ts` (added `EXECUTOR_SECRET_KEY`)
- `worker/src/lib/executor.ts` (new)
- `worker/src/lib/approvalSubmitter.ts` (new)
- `worker/src/lib/orderEval.ts` (dispatches by flow)
- `worker/src/routes/orders.ts` (POST validates either flow; GET returns new fields)
- `worker/src/index.ts` (added `/config`)
- `worker/scripts/generate-executor-key.mjs` (new)
- `worker/src/routes/orders.test.ts` (5 new tests)

Frontend:
- `src/lib/keeperApi.js` (added `getConfig`)
- `src/hooks/useKeeperApprovalOrder.js` (new)
- `src/hooks/useKeeperConfig.js` (new)
- `src/hooks/useKeeperOrders.jsx` (returns `flow`, `delegated_amount_at_placement`, etc.)
- `src/hooks/useTradeSubmit.js` (limit orders → approval flow; sells → legacy)
- `src/components/ActiveOrders.jsx` (badge + revoke button)

Tests:
- Worker: 60 pass (was 55, +5 for approval flow validation).
- Frontend: 151 pass (no regressions).
