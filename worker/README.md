# PredictFlow keeper Worker

Cloudflare Worker that owns the limit-order lifecycle: persistence, sign-in-with-Solana auth, durable-nonce signed-tx capture, real-time trigger evaluation against DFlow's `prices` WS channel, and on-chain submission via Helius.

This Worker complements the existing CF Pages frontend (`/dist`) and Pages Functions DFlow proxy (`/functions`) — same Cloudflare account, separate deploy. **It is not the website.**

## Phase status

- **Phase 1 (this directory):** scaffold, D1 schema, SIWS auth, order CRUD with ownership checks. Orders persist; trigger engine is a stub.
- **Phase 2:** durable-nonce flow + signed-tx capture (frontend + backend).
- **Phase 3:** PriceWatcher Durable Object — DFlow `prices` WS, trigger evaluation.
- **Phase 4:** submission consumer — `sendRawTransaction` via Helius, retries, idempotency.
- **Phase 5:** frontend migration off localStorage.
- **Phase 6:** observability + safety hardening.

## Local development

End-to-end walkthrough for getting the keeper running on your laptop with the
frontend talking to it. Total first-time setup is ~10 minutes once the
prerequisites are in place.

### Prerequisites

- **Node.js ≥ 20** (matches the frontend; check with `node -v`).
- **A Cloudflare account** — free tier is fine for dev. The Wrangler CLI (installed as a dev dependency below) authenticates against it via OAuth.
- **A DFlow API key** — dev-tier key works; you don't need a prod key just to run the keeper locally.
- **A Helius RPC API key** — free tier works; dev limits are well above what a single-developer keeper hits.
- **OpenSSL** for generating local secrets (`openssl rand -base64 32`). Pre-installed on macOS and most Linux distros.

### 1. Install dependencies

From inside `worker/`:

```bash
npm install
```

This installs Wrangler locally — every subsequent command uses `npx wrangler` so you don't need a global install.

### 2. Authenticate Wrangler with Cloudflare

```bash
npx wrangler login
```

Opens your browser for OAuth. After consent, the CLI stores a token under `~/.wrangler/`. Required even for local dev because Wrangler reads your D1 / DO bindings against your account.

Verify it worked:

```bash
npx wrangler whoami
# → You are logged in with the OAuth Token, associated with the email <you>@…
```

### 3. Create the D1 database (one-time, shared across local + remote)

```bash
npx wrangler d1 create predictflow
```

Output looks like:

```
✅ Successfully created DB 'predictflow' in region <…>
[[d1_databases]]
binding = "DB"
database_name = "predictflow"
database_id = "<UUID>"
```

Copy the `database_id` UUID into **both** `[[d1_databases]]` blocks in `wrangler.toml` — the default block and the `[[env.production.d1_databases]]` block — replacing the `REPLACE_WITH_DATABASE_ID` placeholder.

The same `predictflow` database serves local dev (a SQLite copy under `.wrangler/state/v3/d1/`) and remote envs (the actual D1 instance on Cloudflare's edge). Wrangler keeps them separate via the `--local` / `--remote` flags below.

### 4. Apply schema migrations

Local SQLite copy:

```bash
npm run db:migrate:local
```

This applies `migrations/0001_init.sql` to the local D1. Re-run after schema changes; Wrangler tracks which migrations have been applied per environment.

If you also want preview / production schema applied now (you'll need it before deploying), run:

```bash
npm run db:migrate:remote          # preview env
npm run db:migrate:remote:prod     # production env
```

### 5. Create `.dev.vars` from the template

Wrangler reads local-only secrets from `worker/.dev.vars` (gitignored). Copy the template and fill it in:

```bash
cp .dev.vars.example .dev.vars
```

Generate the two cryptographic keys and paste their output into the file:

```bash
openssl rand -base64 32   # → SIGNED_TX_KEY
openssl rand -base64 32   # → SESSION_SIGNING_KEY
```

Final `.dev.vars` should look like:

```
SIGNED_TX_KEY="vQ8xN…(44 chars)…="
SESSION_SIGNING_KEY="3kA2J…(44 chars)…="
DFLOW_API_KEY="dflow_dev_<from DFlow team>"
HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<your key>"
```

Don't reuse production keys here. The whole point of `.dev.vars` is that it's local-only and disposable.

### 6. Run the worker

```bash
npm run dev
```

Wrangler boots the Worker on `http://localhost:8787` with:

- Durable Objects backed by local SQLite under `.wrangler/state/`.
- D1 bindings pointing at the local SQLite copy (the `--local` flag is implicit in `npm run dev`).
- Secrets loaded from `.dev.vars`.
- `nodejs_compat` enabled.

Keep this terminal open; logs stream live, including incoming requests and any `console.log` calls from your code. `Ctrl-C` to stop.

### 7. Smoke-test the keeper

Open a second terminal and check the public health endpoint:

```bash
curl http://localhost:8787/health
# → {"ok":true,"env":"preview","time":1714220000000}
```

Then exercise the SIWS auth flow with a known dev wallet (replace `WALLET` with a Solana pubkey you control):

```bash
WALLET="<base58 pubkey>"

# 1. Issue a challenge
curl -s -X POST http://localhost:8787/auth/challenge \
  -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\"}" | jq
# → { "nonce": "…hex…", "message": "localhost:8787 wants you to sign in…", "expiresAt": 17142… }
```

Verifying requires an actual Solana signature over the `message` payload — the simplest way is to drive this through the frontend (next step) rather than scripting it.

### 8. Run the frontend against the local keeper

In the repo root (one directory up from `worker/`), set `VITE_KEEPER_API_BASE` and start the frontend:

```bash
cd ..
echo 'VITE_KEEPER_API_BASE="http://localhost:8787"' >> .env.local
npm run dev
```

Vite serves the SPA on `http://localhost:5173`. Connect a Solana wallet, place a limit order — you'll see:

1. A wallet popup prompting you to sign the SIWS challenge (one time per session).
2. A wallet popup to fund a fresh durable nonce account (~0.0015 SOL on devnet/mainnet — pick a wallet with a small balance).
3. A wallet popup to sign the durable-nonce-bound DFlow swap.
4. The order shows up in `Active Orders` with the "keeper" badge.

Watch the worker terminal — you should see logs for each request and a `price_watcher_open_failed` line transiently while the DO connects to DFlow's prices WS.

> **Heads up — local PriceWatcher reach:** the local Wrangler runtime can connect to DFlow's WS, but the dev DFlow endpoint requires no API key. If you're testing a market that's prod-only, swap `DFLOW_WS_URL` in `wrangler.toml` to the dev variant for local runs.

### 9. Common dev tasks

```bash
npm run dev                          # run the worker (hot-reloads on src/ changes)
npm test                             # run unit tests (vitest, one-shot)
npm run typecheck                    # tsc --noEmit
npm run db:console:local -- "SELECT * FROM orders LIMIT 5"   # query local D1
npm run db:migrate:local                                     # apply new migrations
npm run tail                                                  # stream production logs (after deploy)
```

### 10. Reset local state (when something gets wedged)

```bash
rm -rf .wrangler/
npm run db:migrate:local
```

Wipes the local D1 + DO storage and re-applies migrations. Doesn't touch remote data.

## Production deployment

Step-by-step for a first-time prod deploy. Once it's done, subsequent deploys are a single `npm run deploy:prod` command — but the first time has account-level setup that's easy to miss.

### Pre-flight checklist

Before pushing the first prod deploy, confirm:

- [ ] `npm test` passes locally.
- [ ] `npx tsc --noEmit` is clean.
- [ ] `wrangler.toml` has the real `database_id` in **both** `[[d1_databases]]` blocks (default + production).
- [ ] `wrangler.toml` `ALLOWED_ORIGIN` for production points at the real frontend domain (e.g. `https://predictflow.app`), not `http://localhost:5173`.
- [ ] You have the production DFlow API key, production Helius RPC URL, and a way to set them as Wrangler secrets.
- [ ] The frontend will know how to reach this Worker — decide on a custom domain (e.g. `api.predictflow.app`) or accept the default `predictflow-keeper-prod.<account>.workers.dev` URL.

### Step 1 — Apply schema to production D1

```bash
npm run db:migrate:remote:prod
```

Wrangler reads the production `[[d1_databases]]` block from `wrangler.toml` and applies any pending migrations to the prod D1 instance. Idempotent — safe to re-run; it skips already-applied migrations.

Verify:

```bash
npx wrangler d1 execute predictflow --remote --env production \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
# → orders, durable_nonces, sessions, auth_challenges, audit_log
```

### Step 2 — Provision production secrets

Each `wrangler secret put` opens a prompt for the value (pipe in via stdin to avoid leaving plaintext in shell history). Use **fresh, unique** secrets for production — never reuse local-dev values.

```bash
# 32-byte AES-256 key for encrypting signed-tx blobs at rest
openssl rand -base64 32 | npx wrangler secret put SIGNED_TX_KEY --env production

# 32-byte HMAC key for session-token signatures
openssl rand -base64 32 | npx wrangler secret put SESSION_SIGNING_KEY --env production

# DFlow production API key (from the DFlow team)
printf '%s' '<dflow-prod-key>' | npx wrangler secret put DFLOW_API_KEY --env production

# Helius mainnet RPC URL with key embedded
printf '%s' 'https://mainnet.helius-rpc.com/?api-key=<helius-key>' | \
  npx wrangler secret put HELIUS_RPC_URL --env production
```

Verify:

```bash
npx wrangler secret list --env production
# → [{"name":"SIGNED_TX_KEY",…}, {"name":"SESSION_SIGNING_KEY",…},
#    {"name":"DFLOW_API_KEY",…}, {"name":"HELIUS_RPC_URL",…}]
```

> **Security note:** Wrangler stores the secrets server-side at Cloudflare. They never appear in `wrangler tail` output, dashboard previews, or build logs. Treat them like database credentials.

### Step 3 — First production deploy

```bash
npm run deploy:prod
```

Wrangler:

1. Bundles `src/` into a single Worker artifact.
2. Provisions the `PriceWatcher` Durable Object class on first deploy (you'll see `Created Durable Object class PriceWatcher` in the output — this only happens once per environment).
3. Binds `DB` to the production D1 instance.
4. Uploads the artifact to Cloudflare's edge.
5. Prints the URL: `https://predictflow-keeper-prod.<account>.workers.dev`.

If this is the very first deploy the DO migration listed in `wrangler.toml`'s `[[migrations]]` block runs automatically. Subsequent deploys skip it (and a `[[migrations]]` change with a new `tag` would run an additional migration).

### Step 4 — Smoke test the live deploy

```bash
WORKER_URL="https://predictflow-keeper-prod.<account>.workers.dev"

# Health check
curl -s "$WORKER_URL/health"
# → {"ok":true,"env":"production",…}

# CORS preflight from your frontend origin (use the actual domain)
curl -sI -X OPTIONS "$WORKER_URL/orders" \
  -H "Origin: https://predictflow.app" \
  -H "Access-Control-Request-Method: POST"
# → HTTP/2 204
# → access-control-allow-origin: https://predictflow.app
```

If the CORS header doesn't appear, `ALLOWED_ORIGIN` in `wrangler.toml` is wrong or the deploy didn't pick it up — confirm with `wrangler tail --env production` and re-deploy.

### Step 5 — Custom domain (optional, recommended)

By default the worker is reachable at `predictflow-keeper-prod.<account>.workers.dev`. Most teams want it under their own apex (e.g. `api.predictflow.app`).

Two options:

**Option A — Workers Custom Domain (quickest if your zone is on Cloudflare):**

1. Cloudflare dashboard → Workers & Pages → `predictflow-keeper-prod` → **Triggers** → **Custom Domains** → **Add Custom Domain**.
2. Enter `api.predictflow.app`. Cloudflare adds the DNS record automatically and provisions a TLS cert in ~1 minute.

**Option B — Workers Route (if you want path-prefix routing on an existing domain):**

1. Same dashboard page → **Routes** → **Add route**.
2. Pattern: `predictflow.app/keeper/*` (or whatever path scheme).
3. Update the frontend's `VITE_KEEPER_API_BASE` and `wrangler.toml` `ALLOWED_ORIGIN` to match.

Either way: re-run the smoke test (Step 4) against the new domain to confirm.

### Step 6 — Wire the frontend

Set `VITE_KEEPER_API_BASE` in the frontend's production env vars (Cloudflare Pages → Settings → Environment Variables) to the Worker URL chosen in Step 5. Trigger a fresh frontend build so the new var is inlined.

```bash
# In the frontend's CF Pages env (Production)
VITE_KEEPER_API_BASE=https://api.predictflow.app
```

After the frontend redeploys, place a limit order with a real wallet and confirm the order appears in `Active Orders` with the "keeper" badge.

### Step 7 — Tail logs while testing

Keep this open in a terminal during the first real-traffic test:

```bash
npm run tail:prod
```

`wrangler tail` streams every request, console log, and uncaught error. Look for:

- `audit_failed` — D1 write hiccup (rare).
- `price_watcher_open_failed` — DFlow WS handshake issue (check API key + URL).
- `submit_order_unhandled` — submitter hit an unhandled exception (this should never appear; if it does, file an issue).

### Subsequent deploys

Once the bootstrap is done, every prod deploy is one command:

```bash
npm run deploy:prod
```

Wrangler does an atomic version swap — old version serves traffic until the new one is ready, then traffic flips. Zero downtime, no in-flight request gets killed mid-execution.

If a deploy goes bad, roll back via the dashboard:

1. Cloudflare → Workers & Pages → `predictflow-keeper-prod` → **Deployments**.
2. Pick the last known-good deploy → **⋯ → Rollback to this version**.

Rollback is instant. Secret values and bindings stay aligned to the rolled-back code automatically.

### Subsequent migrations

When you add a new migration file:

```bash
# After committing the new SQL file under migrations/
npm run db:migrate:remote:prod
```

D1 migrations are forward-only — there is no built-in down-migration. If you need to revert, write a corrective forward migration. Always test schema changes in preview first.

## Endpoints (Phase 1)

All bodies are JSON. Bearer token in `Authorization: Bearer <token>` for `/orders/*`.

```
GET  /health                    public, liveness check
POST /auth/challenge            { wallet } -> { nonce, message, expiresAt }
POST /auth/verify               { wallet, nonce, signature(b58) } -> { token, expiresAt, wallet, sessionId }
GET  /auth/me                   bearer -> { wallet, expiresAt, sessionId } | { wallet: null }
POST /auth/logout               bearer -> { ok }
POST /orders                    bearer, { marketTicker, side, orderType, triggerPrice, amountUsdc, ... } -> { id, status, createdAt }
GET  /orders                    bearer, ?status=&market= -> { orders }
GET  /orders/:id                bearer -> single order
POST /orders/:id/cancel         bearer -> { id, status: 'cancelled' }
```

## Operational notes

- **Audit log is append-only** — never run `DELETE FROM audit_log` outside a documented retention policy. Every state transition routes through `lib/audit.ts`.
- **Encrypt-at-rest covers signed-tx blobs only.** Order metadata (trigger, amount, side) is plaintext — needed by the trigger engine in Phase 3 without round-tripping the key. Treat the D1 database as customer-data sensitive but not catastrophic on its own.
- **Sessions are HMAC-signed JSON, not JWTs** — by design. Avoids the `alg=none` and alg-confusion footguns. See `src/lib/session.ts`.
- **`wallet` in every query**: the access-control invariant of this service is that every D1 query that reads or mutates a per-user table includes a `WHERE wallet = ?` predicate bound to `c.var.wallet` from the session middleware. Adding a new route? Read `middleware/auth.ts` first.

## Troubleshooting

- **Migrations can't apply**: did you copy `database_id` into the production block too? `wrangler d1 migrations apply --env production` reads from that block.
- **Session immediately invalid**: check that `SESSION_SIGNING_KEY` is set in the same environment you deployed to. Mixing `production` and default vars produces tokens that mint in one env and reject in another.
- **`access-control-allow-origin` not appearing**: `ALLOWED_ORIGIN` in `wrangler.toml` must exactly match the frontend's origin (no trailing slash). The Worker only echoes back when the request `Origin` matches.
