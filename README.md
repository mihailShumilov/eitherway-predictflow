# PredictFlow

**A production-grade prediction-market trading terminal for Solana — built on Eitherway, powered by DFlow.**

PredictFlow is the **Eitherway Frontier Hackathon** entry for the **DFlow track**. It turns DFlow's prediction-market liquidity (Kalshi-style YES/NO outcomes) into a real trading surface: market, limit, stop-loss, take-profit, and DCA orders, with a non-custodial keeper that fires conditional orders even when the user's tab is closed.

> **Track:** DFlow · **Partner integrations:** DFlow (primary, deep) · Solflare (wallet) · QuickNode / Helius (Solana RPC)

---

## Submission

| | |
| --- | --- |
| **Live dApp** | https://predictflow.pages.dev *(replace with your Eitherway-deployed URL at submission time)* |
| **Demo video** | *(2–3 min walkthrough — link at submission)* |
| **GitHub** | this repository |
| **Cluster** | Solana **mainnet** |
| **Built with** | [Eitherway](https://eitherway.ai/chat) |

### What to look at in the demo

1. Connect a Solflare or Phantom wallet on the live dApp.
2. Open any active prediction-market event (Sports / Politics / Crypto / Economics).
3. Place a small ($0.10) **market** swap — DFlow returns a routed Solana tx; the wallet signs once.
4. Place a **limit BUY** at a trigger above current ask. The wallet sees a single `spl-token approve` popup. The keeper fires the swap server-side when the trigger crosses (close the tab — it still fills).
5. Open the Portfolio tab — Token-2022 outcome holdings show through, with one-click stop-loss / take-profit on filled positions.

---

## Why this fits the DFlow track

DFlow's track focus is "**trading infrastructure and execution quality across spot crypto and prediction markets**." PredictFlow is built **around** that primitive, not next to it:

| DFlow capability | How PredictFlow uses it |
| --- | --- |
| `/api/v1/events` + `/api/v1/markets` REST | Catalog of every active prediction-market event, grouped by category, with live order-book + trade history. |
| `/api/v1/orderbook` + `/api/v1/trades` + `/api/v1/candles` | Hand-drawn canvas charts (depth, candlesticks, 48h price history) — no recharts; ~150 kB shaved off the bundle. |
| `wss://api.prod.dflow.net/ws prices channel` | Real-time tickers in the browser **and** in the keeper's PriceWatcher Durable Object — same WS feed, two consumers. |
| `/quote` (USDC → outcome mint) | Pre-trade quote in the trade panel; drives slippage + fee preview before the user signs. |
| `/order` (returns a routed Solana tx) | Every market / limit / SL / TP / DCA fill goes through DFlow's MEV-protected routing. The browser never builds swap instructions itself. |
| DFlow `destinationWallet` parameter | Lets the keeper hold a thin executor key while outcome tokens still settle to the user's wallet — non-custodial in the standard industry sense. |
| `/proof` KYC | Just-in-time KYC re-check before every trade submission; browsing is never gated. The keeper deliberately does **not** add server-side KYC — DFlow enforces at swap time. |

### What "deep integration" looks like in this repo

- **Edge proxy with API-key isolation** — `functions/api/dflow*` (Cloudflare Pages Functions) injects `DFLOW_API_KEY` at the edge. The browser bundle only ever sees same-origin `/api/dflow*` paths; the upstream host and key never enter `import.meta.env`.
- **Whitelisted-program tx decoder** — DFlow's `/order` response is decoded with `@solana/web3.js`, every instruction's `programId` is asserted against an allowlist (System / SPL Token / ATA / ComputeBudget / Memo + the DFlow router from `VITE_DFLOW_ALLOWED_PROGRAMS`), and `simulateTransaction` runs **before** the wallet ever sees a signing prompt. A compromised proxy can't drain a wallet.
- **Approval-flow keeper** — limit / SL / TP orders use a single `spl-token approve` (Lighthouse-immune, works on Phantom). The keeper holds a per-user delegated allowance bounded on-chain; users can `revoke` from the Active Orders panel at any time. Source: `worker/src/lib/approvalSubmitter.ts`.
- **Dual WS consumer** — the keeper's `PriceWatcher` Durable Object subscribes to the same DFlow `prices` channel the browser uses, evaluates triggers in-memory, and submits via Helius the moment a threshold crosses. Latency is dominated by Solana confirmation (~1.5s), not our path.
- **Token-2022 aware portfolio** — outcome-mint balances are scanned across both classic SPL Token and Token-2022 program IDs, so YES/NO holdings show even when DFlow lists them under the newer program.

---

## Other partner integrations

- **Solflare** — first-class wallet adapter (browser-injected `window.solflare`, mobile deep-link, transaction signing via `signAndSendTransaction` with a `signTransaction` fallback). Pair of in-browser checks: signed transactions are fully decoded + program-whitelisted before being handed to Solflare for signing.
- **QuickNode / Helius** — paid Solana RPC is required in production for `simulateTransaction` preflight (the public endpoint is rate-limited). The keeper uses Helius for `sendRawTransaction` + signature confirmation polling. RPC URL is configured via `VITE_SOLANA_RPC_ENDPOINTS` on the frontend and `HELIUS_RPC_URL` on the keeper.

The submission's primary track is **DFlow**, but Solflare and QuickNode are wired in as deeply as the product needs.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser — React SPA (Vite, Tailwind, terminal aesthetic)        │
│  Markets · Trade Panel · Portfolio · Active Orders · Pricing     │
└─────────┬────────────────┬──────────────────────┬────────────────┘
          │ /api/dflow*    │ wss://…dflow.net/ws  │ Solana RPC
          ▼                ▼                      ▼
   ┌────────────────────────┐   ┌──────────┐  ┌──────────────────┐
   │ Cloudflare Pages       │   │ DFlow WS │  │ Helius / QuickNode│
   │ Function (DFlow proxy) │   │ (prices) │  │ (preflight + send)│
   │ + DFLOW_API_KEY header │   └──────────┘  └──────────────────┘
   └───────────┬────────────┘                          ▲
               │                                       │
               ├─▶ DFlow REST   (events / book / trades / candles)        │
               ├─▶ DFlow /quote (USDC → outcome-mint price)                │
               └─▶ DFlow /order (returns a Solana tx for the wallet)       │
                                                                           │
   Browser ──HTTP──▶ Keeper Worker (limit-order API, /orders, /auth)       │
                       │                                                   │
                       ├─D1──▶ orders, sessions, token_approvals,          │
                       │       durable_nonces, audit_log                   │
                       ├─DO──▶ PriceWatcher (one per market)               │
                       │         └─WS── DFlow `prices` (real-time triggers)│
                       └─RPC─▶ Helius (sendRawTransaction)  ───────────────┘
```

### Order types and where they execute

| Order type     | Direction          | When `VITE_KEEPER_API_BASE` is set | When unset (legacy)        |
|----------------|--------------------|------------------------------------|----------------------------|
| Market         | USDC → outcome     | Browser-direct DFlow `/order`      | Same                       |
| Limit          | USDC → outcome     | **Keeper** (approval flow)         | Browser, tab-dependent     |
| Stop-loss      | outcome → USDC     | **Keeper** (approval flow)         | Browser, tab-dependent     |
| Take-profit    | outcome → USDC     | **Keeper** (approval flow)         | Browser, tab-dependent     |
| DCA            | USDC → outcome     | Browser, tab-dependent             | Browser, tab-dependent     |

### Custody model

**Non-custodial in the standard industry sense.** The keeper holds an executor key that is bounded per-user, per-mint, by an on-chain `spl-token approve` delegation. The user signs every approve, can `revoke` at any time, and the keeper's blast radius is capped at the sum of active approved allowances. No private keys ever leave the user's wallet. See `worker/README.md` for the full custody and rotation model.

---

## Repository layout

```
.
├── src/                       React SPA (Vite + Tailwind, terminal aesthetic)
│   ├── components/            Markets, TradePanel, Portfolio, ActiveOrders, monetization/
│   ├── hooks/                 useMarkets, useLivePrices, useWallet, useTradeSubmit, useKeeper*
│   ├── lib/                   txDecoder + program whitelist, solanaPreflight, feeTransfer
│   ├── services/              feeService, referralService
│   └── config/env.js          Single source of truth for env-derived constants
├── functions/                 Cloudflare Pages Functions (DFlow REST/quote/order proxies)
├── worker/                    Cloudflare Worker keeper (limit/SL/TP server-side execution)
│   ├── src/                   Hono routes, PriceWatcher DO, approval submitter
│   ├── migrations/            D1 schema (orders, token_approvals, durable_nonces, audit_log)
│   ├── README.md              Keeper local dev + production deployment walkthrough
│   └── RUNBOOK.md             Keeper operations: SQL queries, incident response, key rotation
├── public/_headers            CSP + security headers (CF Pages)
├── public/_redirects          SPA fallback (CF Pages)
├── deploy/nginx.conf          Self-hosted deploy reference
├── vercel.json / netlify.toml Alternate deploy targets
└── .env.example               Canonical env-var list
```

---

## Quick start

### Frontend only

```bash
git clone <this repo> predictflow && cd predictflow
npm install
cp .env.example .env.local       # defaults work out of the box (dev DFlow cluster)
npm run dev                      # → http://localhost:5173
```

You'll get the catalog from DFlow's dev cluster, browser wallet connect, and the full UI. Trades against the dev cluster require real USDC on whichever cluster `VITE_SOLANA_RPC_ENDPOINTS` points at.

### Frontend + keeper (full feature parity)

```bash
# Terminal 1 — frontend
npm run dev                                            # → http://localhost:5173

# Terminal 2 — keeper Worker
cd worker
npm install
cp .dev.vars.example .dev.vars                          # then fill in keys
npm run db:migrate:local
npm run dev                                            # → http://localhost:8787

# Point the frontend at the local keeper
echo 'VITE_KEEPER_API_BASE="http://localhost:8787"' >> ../.env.local
```

Full keeper walkthrough (Wrangler login, D1 creation, executor keypair, smoke tests) lives in [`worker/README.md`](./worker/README.md).

### Useful scripts

```bash
npm run dev           # Vite dev server
npm run build         # Production build → dist/
npm run preview       # Serve dist/ locally
npm test              # Vitest (one-shot)
npm run size          # Gzipped bundle-size budget check (CI-enforced)
```

---

## Environment variables

Two flavors, same `.env`:

- **`VITE_*`** — read in client code (`src/config/env.js`), inlined into the browser bundle. **Never put a secret here.**
- **No-prefix** (e.g. `DFLOW_UPSTREAM`, `DFLOW_API_KEY`) — read by `vite.config.js` (dev proxy) and Cloudflare Pages Functions (prod proxy). Server-side only.

### DFlow (server-side — proxy + auth, never in the bundle)

| Var | Default | Notes |
| --- | --- | --- |
| `DFLOW_UPSTREAM` | `https://dev-prediction-markets-api.dflow.net` | REST host. **Prod:** `https://prediction-markets-api.dflow.net`. |
| `DFLOW_QUOTE_UPSTREAM` | `https://dev-quote-api.dflow.net/quote` | **Prod:** `https://quote-api.dflow.net/quote`. |
| `DFLOW_ORDER_UPSTREAM` | `https://dev-quote-api.dflow.net/order` | **Prod:** `https://quote-api.dflow.net/order`. |
| `DFLOW_API_KEY` | *empty* | DFlow auth key. Injected by the Pages Functions on every upstream call. **Set as Secret in prod.** |
| `DFLOW_API_KEY_HEADER` | `Authorization` | Default sends `Authorization: Bearer <key>`. Override to e.g. `x-api-key` for raw-key headers. |

### DFlow (client — same-origin proxy paths, safe in the bundle)

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_DFLOW_PROXY_BASE` | `/api/dflow` | Base path for REST proxy. |
| `VITE_DFLOW_QUOTE_URL` | `/api/dflow-quote` | Same-origin quote proxy. |
| `VITE_DFLOW_ORDER_URL` | `/api/dflow-order` | Same-origin order proxy. |
| `VITE_DFLOW_WS_URL` | `wss://api.prod.dflow.net/ws` | WebSocket goes browser-direct (no proxy). |
| `VITE_DFLOW_ALLOWED_PROGRAMS` | *empty* | Comma-separated extra program IDs for the tx-decoder allowlist. **Populate with the DFlow router program before shipping real swaps.** |
| `VITE_KEEPER_API_BASE` | *empty* | Public URL of the deployed keeper Worker. When set, conditional orders run server-side. |
| `VITE_SOLANA_RPC_ENDPOINTS` | `https://api.mainnet-beta.solana.com` | Comma-separated. **Use a paid provider in prod** (Helius / QuickNode / Triton). |

### Other

| Var | Notes |
| --- | --- |
| `VITE_USDC_MINT` | Mainnet USDC default. |
| `VITE_PROOF_URL` / `VITE_KYC_CHECK_URL` | DFlow Proof URL + optional backend-authoritative KYC re-check. |
| `VITE_FEE_WALLET` | Solana pubkey that receives platform swap fees and tier subscription payments. Leave unset for revenue-disabled demos. |
| `VITE_SENTRY_DSN` / `VITE_ANALYTICS_*` | Optional observability (Sentry, PostHog, Plausible). |
| `VITE_ALLOW_SYNTHESIZED_MINTS` / `VITE_ALLOW_SIMULATED_FILLS` | Demo-mode safety flags. **Default `false`. Never enable in prod.** |

Full canonical list lives in [`.env.example`](./.env.example).

---

## Production deployment

PredictFlow has **two deployable pieces**:

1. **Frontend SPA + DFlow proxy** — static `dist/` + Cloudflare Pages Functions. Defaults target Cloudflare Pages; alternate `vercel.json` / `netlify.toml` / `deploy/nginx.conf` ship for those hosts but require equivalent serverless functions for `/api/dflow-quote` + `/api/dflow-order`.
2. **Keeper Worker** (`worker/`) — Cloudflare Worker with D1 + Durable Objects. Different artifact, different secrets. Deploys independently. Without it, the frontend works, but conditional orders fall back to the tab-dependent legacy path.

### Cloudflare Pages — pre-flight

- [ ] Push the repo to GitHub → Cloudflare Pages → Connect to Git → build `npm run build`, output `dist/`, `NODE_VERSION=20`.
- [ ] Production secrets (Cloudflare Pages → Settings → Variables and Secrets):
  - `DFLOW_UPSTREAM=https://prediction-markets-api.dflow.net`
  - `DFLOW_QUOTE_UPSTREAM=https://quote-api.dflow.net/quote`
  - `DFLOW_ORDER_UPSTREAM=https://quote-api.dflow.net/order`
  - `DFLOW_API_KEY=<prod key>` *(Secret)*
- [ ] Production `VITE_*` env vars: `VITE_DFLOW_PROXY_BASE=/api/dflow`, `VITE_DFLOW_QUOTE_URL=/api/dflow-quote`, `VITE_DFLOW_ORDER_URL=/api/dflow-order`, `VITE_DFLOW_ALLOWED_PROGRAMS=<router program id>`, `VITE_SOLANA_RPC_ENDPOINTS=<paid RPC>`, `VITE_FEE_WALLET=<your pubkey>`.
- [ ] Confirm the bundle has no leak after build:
  ```bash
  grep -E 'prediction-markets-api|quote-api\.dflow|<key prefix>' dist/assets/*.js
  # Expected: no matches
  ```
- [ ] Deploy keeper too — see [`worker/README.md`](./worker/README.md), then set `VITE_KEEPER_API_BASE=<keeper URL>` here and trigger a frontend rebuild.

### Smoke test against the live deploy

```bash
URL="https://<your-domain>"

# 1. Static + security headers
curl -sI "$URL/" | grep -E '^(HTTP|strict-transport|x-frame)'

# 2. DFlow REST proxy
curl -s "$URL/api/dflow/api/v1/events?status=active&withNestedMarkets=true&limit=1" | head -c 300
# → JSON starting with {"events":[...]}

# 3. SPA fallback
curl -sI "$URL/random/deep/link" | grep '^content-type'
# → content-type: text/html
```

Then in a browser: connect a Solflare wallet, place a $1 market trade, watch the CF Pages → Functions real-time logs for proxy errors.

---

## Security model

### DFlow API-key isolation

The DFlow API key never reaches the browser. The browser bundle only references same-origin `/api/dflow*` paths; the upstream hostnames and the key live exclusively in:

- **Prod:** Cloudflare Pages env (server-side), read at request time by the Pages Functions in `functions/api/`.
- **Dev:** `.env.local` (no `VITE_` prefix), read at startup by `vite.config.js` and attached to the dev proxy headers.

The shared helper at `functions/_lib/dflow-proxy.js` rejects non-GET/HEAD/OPTIONS verbs, so a compromised frontend bundle cannot turn the proxy into a blind relay for state-changing requests.

### Transaction signing

Every signed transaction goes through four defenses in order:

```
DFlow /order response
  │
  ▼
validateTxPayload(tx)        ← reject payloads bigger than 2 × MAX_TX_SIZE
  ▼
decodeDflowTransaction(tx)   ← parse via @solana/web3.js
  ▼
assertAllowedPrograms(tx)    ← every instruction must target a whitelisted program:
                                  System · SPL Token + ATA · ComputeBudget · Memo
                                  · VITE_DFLOW_ALLOWED_PROGRAMS (DFlow router)
  ▼
preflightTransaction(tx)     ← simulateTransaction (sigVerify off, replaceRecentBlockhash on);
                                fails closed if RPC unreachable
  ▼
wallet.signAndSendTransaction(tx)
```

If any step fails the user sees an explicit error, never the signing prompt.

### CSP

`index.html` ships a strict `Content-Security-Policy`: `default-src 'self'`, `script-src 'self'` (no inline scripts), `connect-src` enumerates DFlow + Solana RPC + optional Sentry / PostHog, `img-src` / `font-src` permit Google Fonts + self.

### Privacy

- Wallet pubkeys in analytics events are SHA-256-hashed via `lib/privacy.js#hashWallet`.
- `safeErrorMessage` strips HTML + control chars from errors before they reach Sentry.

---

## How this matches the judging criteria

| Criterion | How PredictFlow addresses it |
| --- | --- |
| **Real-world utility (30%)** | Solves a concrete pain: browser-only conditional orders on prediction markets are unreliable (tab closes, fills miss). The keeper makes limit / SL / TP fire server-side without taking custody. |
| **Product quality (30%)** | Production polish: 151 frontend tests + 60 worker tests, strict CSP, gzipped-size budget enforced in CI, full SPA fallback + security headers, demo-mode banner when DFlow is unreachable, error reporting + analytics shims. |
| **Integration depth (25%)** | DFlow is wired into REST catalog, WS prices, quote, order, Proof KYC, and `destinationWallet` semantics. The keeper consumes the same WS feed as the browser. The tx decoder enforces a whitelist that includes DFlow's router program. |
| **Adoption potential (15%)** | Three subscription tiers (Free / Pro / Whale) with referral splits create a self-sustaining revenue path. Non-custodial keeper reduces the trust ask — most prediction-market traders won't hand over keys to a bot, but they will sign a bounded `approve`. |

### Survives 30 days post-submission

- Deployed on Cloudflare Pages + Workers — both have generous free tiers covering hobby-scale traffic indefinitely.
- D1 database is durable; keeper's storage cost is sub-dollar/month at expected volumes.
- No long-running server processes to babysit. Wrangler `tail` covers ad-hoc debugging.
- No custodial risk to manage — the executor key is bounded by on-chain delegations the user can revoke.

---

## Testing

Vitest + jsdom on the frontend, Vitest + Miniflare on the keeper.

```bash
npm test               # frontend (151 tests across lib/, hooks/, services/, App)
cd worker && npm test  # keeper (60 tests across routes, lib/encryption, lib/session, ...)
```

Coverage focuses on the security-critical paths: tx decoding + allowlist, fee math, durable-nonce capture, approval-flow validation, session middleware (the access-control invariant that every per-user query joins on `wallet`).

---

## Troubleshooting

**"Demo mode" banner stuck on.**
`useMarkets` can't reach `/api/dflow/…/events`. Check the proxy: `curl http://localhost:5173/api/dflow/api/v1/events?limit=1` (dev) or the prod-host equivalent.

**"This market has no tradeable outcome mint yet."**
DFlow hasn't published YES/NO mints for that market. Watch price/depth; place trades elsewhere. For demo-only environments you can flip `VITE_ALLOW_SYNTHESIZED_MINTS=true` — never in prod.

**"Could not verify order with Solana RPC."**
All RPC endpoints in `VITE_SOLANA_RPC_ENDPOINTS` were unreachable during preflight. Add a paid RPC (Helius / QuickNode / Triton) and retry.

**Wallet connects but trades never go through.**
Devtools → Network → look at `/order` and the subsequent decoder error. The most common cause in a fresh install is `VITE_DFLOW_ALLOWED_PROGRAMS` empty so the router program isn't whitelisted.

**Conditional orders never trigger (without keeper).**
Set `VITE_DFLOW_WS_URL` or `VITE_LIVE_PRICE_URL` — without a price feed there's nothing to compare against. Or deploy the keeper for server-side execution.

**Limit order placed but never fires (keeper enabled).**
Open [`worker/RUNBOOK.md`](./worker/RUNBOOK.md) → "Symptom: a user reports their fill never happened" — it walks the audit-log path. Quickest first check:
```bash
cd worker && npm run db:console:remote -- \
  "SELECT id,status,failure_reason FROM orders WHERE wallet='<pubkey>' ORDER BY created_at DESC LIMIT 10"
```

---

## Credits

- Built on [Eitherway](https://eitherway.ai) — generated, iterated, and deployed via the Eitherway chat builder.
- Trades route through [DFlow](https://www.dflow.net) — prediction-market liquidity, MEV-protected execution.
- Wallet UX via [Solflare](https://solflare.com) (and Phantom / Backpack as fallbacks).
- Solana RPC via [QuickNode](https://www.quicknode.com/chains/sol) / [Helius](https://helius.dev).

Submitted to the [**Eitherway Frontier Hackathon — DFlow track**](https://eitherway.ai).
