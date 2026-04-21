# PredictFlow

A terminal-styled prediction-market frontend for Solana. Browse event/market
data, connect a Solana wallet, and place market, limit, stop-loss,
take-profit, or DCA trades that settle through the DFlow quote/order API.

PredictFlow is a **static SPA** — there is no backend in this repo. All
networking goes to DFlow REST/WebSocket endpoints (optionally via a host
proxy) and Solana RPC.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser — React SPA (Vite, Tailwind)                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │  Markets    │  │  Trade Panel │  │  Portfolio / Positions │   │
│  │  (events +  │  │  (market,    │  │  (wallet scan +        │   │
│  │   prices)   │  │   limit, SL, │  │   local positions)     │   │
│  │             │  │   TP, DCA)   │  │                        │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬─────────────┘   │
└─────────┼────────────────┼──────────────────────┼────────────────┘
          │                │                      │
          ▼                ▼                      ▼
   ┌────────────┐  ┌────────────────┐   ┌─────────────────────┐
   │ DFlow REST │  │ DFlow quote/   │   │  Solana RPC         │
   │ (events,   │  │ order API      │   │  (balance scan +    │
   │  orderbook,│  │  → tx payload  │   │   tx preflight)     │
   │  trades,   │  │                │   │                     │
   │  candles)  │  └────────────────┘   └─────────────────────┘
   └────────────┘           │
                            ▼
                    ┌────────────────┐       ┌─────────────────┐
                    │ Wallet signs   │ ───▶  │ Solana mainnet/ │
                    │ (Phantom /     │       │ devnet cluster  │
                    │  Solflare /    │       │                 │
                    │  Backpack)     │       └─────────────────┘
                    └────────────────┘
```

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Data flow](#data-flow)
4. [localStorage schema](#localstorage-schema)
5. [Environment variables](#environment-variables)
6. [Local development](#local-development)
7. [Production deployment](#production-deployment)
8. [Security model](#security-model)
9. [Testing](#testing)
10. [Troubleshooting](#troubleshooting)

---

## Features

**Markets**
- Browse active prediction-market events grouped by category (Sports /
  Politics / Crypto / Economics).
- Live price/volume ticks via WebSocket where available, REST fallback
  otherwise.
- Hand-drawn canvas charts (candlesticks, 48h price history, order-book
  depth) — no recharts runtime; ~150 kB gz removed vs. the original.

**Trading (per market)**
- **Market** — USDC → outcome-mint swap via DFlow `/quote` + `/order`,
  signed by an injected Solana wallet.
- **Limit** — fires when price crosses a threshold (client-side monitor).
- **Stop-loss / take-profit** — only shown when a filled position exists
  for that market.
- **DCA** — recurring buys at a fixed frequency and budget.

**Safety**
- Transaction payload is **decoded and program-whitelisted before signing**
  (System, SPL Token, ATA, ComputeBudget, Memo, plus DFlow router IDs
  from `VITE_DFLOW_ALLOWED_PROGRAMS`).
- `simulateTransaction` preflight fails closed — a server-side swap
  attempting to drain a wallet never reaches the signing prompt.
- Per-submit idempotency key and a module-level submission lock prevent
  double-signs across component remounts.
- Safety flags `VITE_ALLOW_SYNTHESIZED_MINTS` and
  `VITE_ALLOW_SIMULATED_FILLS` default to **off** in production.

**Wallet**
- Pure browser-injected providers — Phantom, Solflare, Backpack.
- Mobile deep-links for Phantom / Solflare via universal links when no
  wallet is detected.

**KYC (Kalshi CFTC-regulated markets)**
- `useKyc` blocks trade / limit / stop-loss / take-profit / DCA submits
  until the user is verified; browsing is never gated.
- Optional `VITE_KYC_CHECK_URL` turns on backend-authoritative KYC —
  re-verifies just-in-time before each submit.

**Observability**
- Sentry- and PostHog-compatible shims; integrations load lazily when the
  corresponding env var **and** package are present.

---

## Architecture

### Provider tree

```
<WalletProvider>
  <KycProvider>
    <HealthProvider>
      <MarketsProvider>
        <LivePricesProvider>
          <OrdersProvider>          ← conditional orders (limit/SL/TP)
            <DCAProvider>
              <LegalModalProvider>
                <AppLayout />
              </LegalModalProvider>
            </DCAProvider>
          </OrdersProvider>
        </LivePricesProvider>
      </MarketsProvider>
    </HealthProvider>
  </KycProvider>
</WalletProvider>
```

Keep this nesting: outer contexts (wallet, kyc) feed the inner ones. Adding
cross-context logic should preserve the order.

### Directory layout

```
src/
├── App.jsx                 Provider tree + top-level layout
├── components/
│   ├── TradePanel.jsx      Trade panel shell (split across components/trade/*)
│   ├── trade/
│   │   ├── SideSelector.jsx
│   │   ├── OrderTypeTabs.jsx
│   │   ├── DcaForm.jsx
│   │   ├── DcaProgress.jsx
│   │   ├── ResultBanner.jsx
│   │   └── TradeStatusBadge.jsx
│   ├── CandlestickChart.jsx
│   ├── PriceChart.jsx      Hand-drawn canvas, no recharts
│   ├── DepthChart.jsx      Hand-drawn canvas, no recharts
│   ├── Portfolio.jsx
│   └── …                   (MarketCard, OrderBook, RecentTrades, …)
├── hooks/
│   ├── useMarkets.jsx      Events + market catalog (DFlow REST, mock fallback)
│   ├── useLivePrices.jsx   WebSocket w/ exp. backoff + circuit breaker
│   ├── useWallet.jsx       Phantom / Solflare / Backpack + mobile deep-link
│   ├── useKyc.jsx          Client / backend-authoritative KYC
│   ├── useConditionalOrders.jsx  Limit/SL/TP monitor loop
│   ├── useDCA.jsx          Recurring-buy strategies
│   ├── usePortfolio.jsx    Wallet-scan via Solana RPC
│   ├── useTradeSubmit.js   Preview/market/conditional/DCA submit logic
│   └── useHealth.jsx       DFlow REST + Solana RPC liveness probe
├── lib/
│   ├── http.js             fetchWithRetry + idempotency
│   ├── solanaPreflight.js  Tx simulation (sigVerify off)
│   ├── txDecoder.js        VersionedTransaction decoder + program whitelist
│   ├── normalize.js        Shared normalizers (candle, level, trade, market)
│   ├── palette.js          Canvas palette reader (CSS-var-backed)
│   ├── storage.js          localStorage + migrations + positions lock
│   └── …                   (privacy, errorReporter, analytics, enums, …)
├── data/
│   ├── mockMarkets.js      Fallback catalog when DFlow is unreachable
│   └── flattenMarkets.js   Tiny extractor so happy-path doesn't pull mocks
└── config/env.js           Single source of truth for env-derived constants
```

### Styling

- Tailwind with `terminal-*` color tokens backed by CSS custom properties
  in `src/index.css`. Canvas charts read the companion `*-hex` vars via
  `getComputedStyle`, so a theme swap never requires touching chart source.
- Monospace: `JetBrains Mono` / `Fira Code`. Sans: `Inter`. Loaded from
  Google Fonts in `index.html`.

---

## Data flow

### Markets catalog

```
MarketsProvider mount
        │
        ▼
  safeGet('predictflow_markets_cache')  ── fresh (< 60s)? ──┐
        │ stale/missing                                      │
        ▼                                                    │
  fetchWithRetry  /api/dflow/…/events?withNestedMarkets=true │
              +  /api/dflow/…/tags_by_categories             │
        │ fail                                               │
        ▼                                                    │
  dynamic import('../data/mockMarkets')  ← fallback catalog  │
        │                                                    │
        ▼                                                    │
  flattenMarkets({ events })  → flat market list    ◀────────┘
        │
        ▼
  Filter (category / search) + sort → render
```

- 60-second localStorage cache so reloads are instant.
- `usingMockData` flag flips a yellow "Demo mode" banner when the real
  fetch fails.

### Live prices

```
LivePricesProvider mount
        │
        ▼
  new WebSocket(VITE_DFLOW_WS_URL)
        │
        ├─ open ─▶ subscribe to market tickers
        ├─ message ─▶ update module-level price map
        │              │
        │              ▼
        │          notify subscribers (useSyncExternalStore)
        │              │
        │              ▼
        │          flash 'green'/'red' per card for 500ms
        │
        └─ error / close
                │
                ▼
         exp. backoff (1s → 60s) + 10-failure circuit breaker
                │                                 │
                └─ REST polling fallback ◀────────┘
                   if VITE_LIVE_PRICE_URL set
```

### Trade submission (market order)

```
User clicks "Buy YES — $50"
        │
        ▼
requireKyc() ─── blocks + opens modal if unverified ──▶ stop
        │ ok
        ▼
verifyWithServer()  ── when VITE_KYC_CHECK_URL set ──┐
        │ ok                                         │ fail ▶ stop
        ▼
submissionLocks.add(nonce)   ← module-level, survives remount
        │
        ▼
fetchWithRetry GET /order?inputMint=USDC&outputMint=YES&amount=…
                        X-Idempotency-Key: mkt-<uuid>
        │
        ▼
validateTxPayload(tx)        ← size cap (≤ 2× MAX_TX_SIZE)
decodeDflowTransaction(tx)   ← parse via @solana/web3.js
assertAllowedPrograms(tx)    ← instructions must be in whitelist
        │
        ▼
preflightTransaction(tx)     ← simulate on Solana RPC, sigVerify:false
        │ fails closed on unreachable RPC
        ▼
provider.signAndSendTransaction(tx)   (fallback: signTransaction)
        │
        ▼
appendPosition(…)   ← withPositionsLock promise chain
        │
        ▼
setResult({ success:true })   ← triggers UI + subscribePositions notify
```

### Conditional orders (limit / stop-loss / take-profit)

```
OrdersProvider
  │ hasPending?  no → idle
  │ yes
  ▼
setInterval(5000, async () => {
  for market of groupBy(pendingOrders, marketId) {
    const price = await fetchLivePrice(market)
    for order of market.orders {
      if shouldTriggerOrder(order, price)
        executeOrder(order, price)   ← same sign-and-swap path as market
    }
  }
})
```

### DCA strategies

```
DCAProvider
  │ hasActive?  no → idle
  │ yes
  ▼
setInterval(1000, async () => {
  for strategy of activeStrategies {
    if (now >= strategy.nextRunAt) {
      const price = await fetchLivePrice(strategy)
      executeTick(strategy, price)   ← same sign-and-swap path
      strategy.nextRunAt = now + FREQUENCIES[strategy.frequency]
      if executions.length >= totalPurchases: mark 'completed'
    }
  }
})
```

---

## localStorage schema

Single source of truth. Keep this table up to date — add a row when you
introduce a new client-persistent key.

| Key                               | Schema version | Purpose                                                                          |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `predictflow_markets_cache`       | 2              | 60s events/markets cache                                                         |
| `predictflow_conditional_orders`  | 2              | Pending / filled / cancelled limit/SL/TP orders                                  |
| `predictflow_dca_strategies`      | 2              | Active / completed / cancelled DCA strategies + execution history                |
| `predictflow_positions`           | 2              | Filled trade positions (gates SL/TP tabs in TradePanel)                          |
| `predictflow_wallet`              | —              | Restored wallet pubkey on reload                                                 |
| `predictflow_wallet_id`           | —              | Restored wallet adapter id (`phantom` / `solflare` / `backpack`)                 |
| `predictflow_kyc_status`          | —              | `unverified` / `pending` / `verified`                                            |
| `predictflow_storage_version`     | —              | Migration tracker; `runMigrations()` runs on app boot                            |

---

## Environment variables

All `VITE_*` vars are inlined into the client bundle at build time. **Never
put server secrets here.** Copy `.env.example` → `.env.local`.

### DFlow

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_DFLOW_PROXY_BASE` | `/api/dflow` | Base path for REST. Proxied by Vite in dev; by Vercel/Netlify/Nginx in prod. |
| `VITE_DFLOW_UPSTREAM` | `https://dev-prediction-markets-api.dflow.net` | Vite-dev-only; what the `/api/dflow` proxy forwards to. |
| `VITE_DFLOW_QUOTE_URL` | `https://dev-quote-api.dflow.net/quote` | Direct call (no proxy). |
| `VITE_DFLOW_ORDER_URL` | `https://dev-quote-api.dflow.net/order` | Direct call (no proxy). |
| `VITE_DFLOW_WS_URL` | `wss://api.prod.dflow.net/ws` | Leave empty to disable WebSocket. |
| `VITE_DFLOW_DOCS_URL` | `https://docs.dflow.net` | Linked from the About modal. |
| `VITE_DFLOW_ALLOWED_PROGRAMS` | *empty* | Comma-separated extra program IDs for `assertAllowedPrograms`. **Populate with the DFlow router program before shipping.** |
| `VITE_LIVE_PRICE_URL` | *empty* | REST fallback for live prices when no WS. `{eventTicker}` is substituted per order. |

### Solana

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_SOLANA_RPC_ENDPOINTS` | `https://api.mainnet-beta.solana.com` | Comma-separated. **Use a paid provider in prod** (Helius / Triton / QuickNode). Public endpoint is rate-limited. |
| `VITE_USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Mainnet USDC. |
| `VITE_SPL_TOKEN_PROGRAM` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | Standard SPL Token program. |

### KYC

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_PROOF_URL` | `https://www.dflow.net/proof` | Where "Verify with Proof" sends the user. Must be `https://` and on `dflow.net` / `proof.com` (enforced in `KycModal`). |
| `VITE_KYC_CHECK_URL` | *empty* | When set, backend is authoritative. POST `{ wallet }` → `{ verified: boolean }`. Polled every 8s while status is `pending`. |

### Observability

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_SENTRY_DSN` | *empty* | Dynamic-import `@sentry/browser` if set and installed. |
| `VITE_ANALYTICS_PROVIDER` | *empty* | `''` / `posthog` / `plausible` / `custom`. |
| `VITE_ANALYTICS_WRITE_KEY` | *empty* | Per-provider secret/write-key. |
| `VITE_ANALYTICS_HOST` | *empty* | Self-hosted endpoint for PostHog. |

### Safety flags

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_ALLOW_SYNTHESIZED_MINTS` | `false` | When `true`, trading panel fakes YES/NO mints for markets without real ones. Real swaps cannot route — demo/test only. |
| `VITE_ALLOW_SIMULATED_FILLS` | `false` | When `true`, a DFlow `/order` failure is treated as a simulated fill. **Never enable for real money.** |

### Legal

`VITE_TERMS_URL` / `VITE_PRIVACY_URL` / `VITE_RISK_URL` /
`VITE_SUPPORT_EMAIL` — linked from the legal modal. All optional.

---

## Local development

### Prerequisites

- **Node.js ≥ 20** (set in `.github/workflows/ci.yml`)
- **npm** (any recent version; a lockfile is committed)
- A Solana wallet extension in your dev browser: Phantom, Solflare, or
  Backpack

### Step-by-step

```bash
# 1. Clone
git clone <your-repo-url> predictflow
cd predictflow

# 2. Install
npm install

# 3. (optional) Copy the env template — defaults work out of the box
cp .env.example .env.local
# edit .env.local — or skip this step entirely

# 4. Run
npm run dev
# Vite prints http://localhost:5173
```

**What works out of the box:**
- Markets catalog via the Vite dev proxy → `VITE_DFLOW_UPSTREAM`
  (dev DFlow host).
- Wallet connect/disconnect.
- All UI flows. Trades against the dev DFlow endpoints require real USDC
  on whichever cluster your `VITE_SOLANA_RPC_ENDPOINTS` points at — by
  default, mainnet.

**If DFlow is unreachable:** the app falls back to `src/data/mockMarkets.js`
and flips a yellow "Demo mode" banner. You can still click markets, open
the trade panel, etc.

### Scripts

```bash
npm run dev           # Vite dev server (port 5173)
npm run build         # Production build → dist/
npm run preview       # Serve dist/ locally (port 4173)
npm test              # vitest run (one-shot)
npm run test:watch    # vitest watch
npm run size          # Gzipped size budget check (CI-enforced)
```

### Enabling demo mode

For a completely offline demo (no DFlow, no Solana RPC):

```bash
# .env.local
VITE_DFLOW_UPSTREAM=https://invalid.local
VITE_ALLOW_SYNTHESIZED_MINTS=true
VITE_ALLOW_SIMULATED_FILLS=true
```

The `/api/dflow` proxy will fail → `useMarkets` falls back to mocks → trades
go through the simulated-fill path. **Never ship this config to production.**

### Hot tips

- Vite uses polling (`usePolling: true`) because the Eitherway host editor
  needs it. Outside Eitherway you can flip this off in `vite.config.js` for
  faster rebuilds.
- Test a single file: `npm test -- src/lib/normalize.test.js`.
- Test by pattern: `npm test -- -t 'normalizeCandle'`.

---

## Production deployment

PredictFlow ships as a static SPA + two required upstream proxies (DFlow
REST and optional KYC backend). There's **no server to run here** —
pick a hosting provider and configure the proxy.

### Pre-flight checklist

Before flipping any prod switch:

- [ ] `.env.production` (or host-env UI) has real DFlow prod URLs.
- [ ] `VITE_DFLOW_ALLOWED_PROGRAMS` includes the DFlow router program ID(s).
- [ ] `VITE_SOLANA_RPC_ENDPOINTS` points to a paid RPC provider
      (Helius / Triton / QuickNode).
- [ ] `VITE_KYC_CHECK_URL` points to a backend that returns
      `{ verified: boolean }` — not the demo client-trust flow.
- [ ] `VITE_SENTRY_DSN` + `VITE_ANALYTICS_*` are set (optional but
      strongly recommended).
- [ ] `VITE_ALLOW_SYNTHESIZED_MINTS=false` and
      `VITE_ALLOW_SIMULATED_FILLS=false` (the defaults — don't override).
- [ ] `npm run build && npm run size` is green locally.
- [ ] Legal copy (`VITE_TERMS_URL`, `VITE_RISK_URL`, etc.) points to real
      pages.

### Option A — Vercel

```
┌──────────┐   /api/dflow/*     ┌──────────────────┐
│ Browser  │ ─────────────────▶ │ Vercel rewrites  │ ─▶ DFlow REST
└──────────┘                    └──────────────────┘
       │ /*                     ┌──────────────────┐
       └──────────────────────▶ │ dist/index.html  │
                                └──────────────────┘
```

1. Push the repo to GitHub.
2. In Vercel → Import Project. Framework preset auto-detects Vite.
3. Add environment variables under Settings → Environment Variables. At
   minimum: all `VITE_DFLOW_*`, `VITE_SOLANA_RPC_ENDPOINTS`,
   `VITE_KYC_CHECK_URL`, `VITE_DFLOW_ALLOWED_PROGRAMS`.
4. Edit `vercel.json` — change the `/api/dflow/(.*)` rewrite destination
   from `https://dev-prediction-markets-api.dflow.net/$1` to the prod
   DFlow host. (Rewrites don't read `$ENV` vars directly; either hardcode
   or use an edge function.)
5. Deploy. Headers (HSTS preload, COOP, CORP, etc.) are already configured.

Already done for you in `vercel.json`:
- SPA fallback (`/((?!…).*)` → `/index.html`)
- Immutable caching for hashed assets
- Security headers (`X-Content-Type-Options`, HSTS preload, COOP, CORP, …)

### Option B — Netlify

1. Push to GitHub → Netlify → Import.
2. Build command: `npm run build`. Publish directory: `dist`.
3. Add env vars under Site settings → Environment variables.
4. Edit `netlify.toml` — change the `/api/dflow/*` redirect destination
   from the dev host to prod.
5. Deploy.

### Option C — Self-hosted Nginx

1. `npm run build` on your build host (or in CI).
2. Copy `dist/` to `/var/www/predictflow/dist`.
3. Drop `deploy/nginx.conf` into `/etc/nginx/sites-available/`. Edit:
   - `server_name`
   - `proxy_pass` in the `/api/dflow/` block — point at prod DFlow
   - Add a TLS cert (certbot or equivalent)
4. `nginx -t && systemctl reload nginx`.

### Option D — CI build + upload to any static host

CI is already wired in `.github/workflows/ci.yml`:

```
push / PR
   │
   ▼
test job   (node 20, npm ci, npm test)
   │
   ▼
build job  (npm ci, npm run build, npm run size)
   │
   ▼
upload-artifact: dist/   (7-day retention)
```

Hook your static host (S3+CloudFront, Render, Azure Static Web Apps, …) to
either the repo or the artifact. For Cloudflare Pages specifically, see
the dedicated step-by-step guide in Option E.

### Option E — Cloudflare Pages (step-by-step PROD deploy)

Cloudflare Pages serves the static `dist/` output from the global edge and
runs a Pages Function to terminate the DFlow proxy. Everything needed is
already committed:

| File | Role |
| --- | --- |
| `public/_redirects` | SPA fallback — copied to `dist/_redirects` at build |
| `public/_headers` | Security headers — copied to `dist/_headers` at build |
| `functions/api/dflow/[[path]].js` | `/api/dflow/*` reverse proxy; reads `DFLOW_UPSTREAM` at runtime |

```
┌──────────┐   /api/dflow/*   ┌──────────────────────┐
│ Browser  │ ───────────────▶ │ Pages Function       │ ─▶ DFlow REST
└──────────┘                  │ env.DFLOW_UPSTREAM   │
       │ /*                   └──────────────────────┘
       └────────────────────▶ dist/index.html  (SPA fallback via _redirects)
```

Because the upstream host is read from an env var at request time, the
same build artifact works across Production/Preview environments — no
need to edit config per environment like `vercel.json` requires.

#### Step 1 — Prerequisites

- A Cloudflare account with Workers & Pages enabled (free tier works).
- The repo pushed to GitHub or GitLab (Cloudflare Pages integrates with
  both).
- The prod DFlow upstream host, the DFlow quote/order URLs, and the
  DFlow router program ID — get these from
  [DFlow docs](https://docs.dflow.net) (the values shipped in
  `.env.example` point at the dev cluster).
- A paid Solana RPC API key (Helius / Triton / QuickNode). The public
  endpoint is rate-limited and will fail preflight under even light real
  traffic.
- A KYC backend that implements the `POST { wallet } → { verified }`
  contract from [Setting up the KYC backend](#setting-up-the-kyc-backend).

#### Step 2 — Create the Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Authorize Cloudflare for your Git provider if prompted, then select
   the PredictFlow repo.
3. On "Set up builds and deployments":
   - **Project name:** `predictflow` (becomes `predictflow.pages.dev`)
   - **Production branch:** `main`
   - **Framework preset:** `None` (Vite is fine, but there's no benefit
     over None here)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** *(leave empty)*

Do **not** click "Save and Deploy" yet — add environment variables first
so the first build uses real values.

#### Step 3 — Environment variables (Production)

Under **Settings → Variables and Secrets → Production**, add the
following. Mark anything sensitive (RPC API keys, analytics write keys)
as **Secret**; everything else can be a plain variable.

> Cloudflare Pages does not separate "build-time" from "runtime" vars
> in the UI. Every variable is available to both. Vite inlines only
> `VITE_*` vars into the browser bundle at build; non-VITE vars
> (`DFLOW_UPSTREAM`, `NODE_VERSION`) stay on the server side and are
> read by the Pages Function / build environment.

**Runtime — consumed by the Pages Function and the build runner:**

| Variable | Production value | Notes |
| --- | --- | --- |
| `DFLOW_UPSTREAM` | `https://prediction-markets-api.dflow.net` | **Required.** Replace with the prod DFlow REST host from DFlow docs. The `/api/dflow` proxy forwards here. |
| `NODE_VERSION` | `20` | **Required.** Matches `.github/workflows/ci.yml`. |

**Build-time — inlined into the client bundle (VITE_*):**

| Variable | Production value |
| --- | --- |
| `VITE_DFLOW_PROXY_BASE` | `/api/dflow` |
| `VITE_DFLOW_QUOTE_URL` | `https://quote-api.dflow.net/quote` *(verify with DFlow docs)* |
| `VITE_DFLOW_ORDER_URL` | `https://quote-api.dflow.net/order` *(verify with DFlow docs)* |
| `VITE_DFLOW_WS_URL` | `wss://api.prod.dflow.net/ws` |
| `VITE_DFLOW_DOCS_URL` | `https://docs.dflow.net` |
| `VITE_DFLOW_ALLOWED_PROGRAMS` | `<DFlow router program ID>` — required for real swaps |
| `VITE_SOLANA_RPC_ENDPOINTS` | `https://mainnet.helius-rpc.com/?api-key=<HELIUS_KEY>` (comma-separate fallbacks) |
| `VITE_USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `VITE_SPL_TOKEN_PROGRAM` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| `VITE_PROOF_URL` | `https://www.dflow.net/proof` |
| `VITE_KYC_CHECK_URL` | `https://kyc.yourdomain.com/check` *(your backend)* |
| `VITE_LIVE_PRICE_URL` | *(optional REST fallback; leave empty if WS is healthy)* |
| `VITE_SENTRY_DSN` | *(optional)* |
| `VITE_ANALYTICS_PROVIDER` | `''` / `posthog` / `plausible` / `custom` |
| `VITE_ANALYTICS_WRITE_KEY` | *(optional, matches provider)* |
| `VITE_ANALYTICS_HOST` | *(optional, self-hosted PostHog)* |
| `VITE_ALLOW_SYNTHESIZED_MINTS` | `false` — **do not override in prod** |
| `VITE_ALLOW_SIMULATED_FILLS` | `false` — **do not override in prod** |
| `VITE_TERMS_URL` | `https://yourdomain.com/terms` |
| `VITE_PRIVACY_URL` | `https://yourdomain.com/privacy` |
| `VITE_RISK_URL` | `https://yourdomain.com/risk` |
| `VITE_SUPPORT_EMAIL` | `support@yourdomain.com` |

Treat `VITE_SOLANA_RPC_ENDPOINTS`, `VITE_SENTRY_DSN`, and
`VITE_ANALYTICS_WRITE_KEY` as secrets in the Cloudflare UI even though
they end up in the bundle — the Secret flag keeps them out of the
dashboard and build logs.

#### Step 4 — Environment variables (Preview)

Repeat Step 3 under **Settings → Variables and Secrets → Preview** with
the *dev* DFlow hosts so preview deploys never touch prod data:

| Variable | Preview value |
| --- | --- |
| `DFLOW_UPSTREAM` | `https://dev-prediction-markets-api.dflow.net` |
| `VITE_DFLOW_QUOTE_URL` | `https://dev-quote-api.dflow.net/quote` |
| `VITE_DFLOW_ORDER_URL` | `https://dev-quote-api.dflow.net/order` |
| `VITE_ALLOW_SIMULATED_FILLS` | `true` *(optional — OK for QA, never in prod)* |

Everything else (KYC, RPC, Proof, legal URLs) can point at the same
values as production, or at dedicated staging endpoints if you have them.

#### Step 5 — Trigger the first deploy

Click **Save and Deploy**. Cloudflare will:

1. Clone the repo on the chosen branch.
2. Run `npm ci && npm run build` with your env vars exposed to Vite.
3. Upload `dist/` to the global edge cache.
4. Deploy `functions/api/dflow/[[path]].js` to the Workers runtime.
5. Publish at `https://predictflow.pages.dev` (unique per project).

First build takes ~90–150 seconds. Watch the **Build log** tab for errors.
Common failures on first deploy:
- **`npm error EBADENGINE`** → `NODE_VERSION` is missing or wrong.
- **Blank markets list after deploy** → `DFLOW_UPSTREAM` not set.
- **"This market has no tradeable outcome mint yet"** for every market →
  `VITE_DFLOW_ALLOWED_PROGRAMS` is empty; real swaps can't route.

#### Step 6 — Custom domain + DNS

1. In the project → **Custom domains** → **Set up a custom domain**.
2. Enter `trade.yourdomain.com` (or apex — Cloudflare supports both).
3. If the zone is on Cloudflare, DNS is added automatically. Otherwise
   add a `CNAME` record pointing `trade.yourdomain.com` at
   `predictflow.pages.dev` in your external DNS provider.
4. Cloudflare issues a TLS cert within ~1 minute; the domain goes
   "Active" once propagation completes.

If you add a custom origin for the KYC backend or analytics that isn't
on `*.dflow.net` / `*.solana.com` / the RPC providers already in the CSP,
update `connect-src` in `index.html` — the CSP is the enforced allowlist.

#### Step 7 — Post-deploy smoke test

Run each check against the production URL (replace `trade.yourdomain.com`
with your own):

```bash
# 1. Static site + security headers
curl -sI https://trade.yourdomain.com/ | grep -E '^(HTTP|strict-transport|x-frame)'
# → HTTP/2 200
# → strict-transport-security: max-age=31536000; includeSubDomains; preload
# → x-frame-options: SAMEORIGIN

# 2. DFlow proxy via Pages Function
curl -s "https://trade.yourdomain.com/api/dflow/api/v1/events?status=active&withNestedMarkets=true&limit=1" \
  | head -c 300
# → JSON payload starting with {"events":[...]}
# 502 here means DFLOW_UPSTREAM is wrong or the upstream is down.

# 3. SPA fallback
curl -sI https://trade.yourdomain.com/random/deep/link | grep '^content-type'
# → content-type: text/html; charset=utf-8
```

Then in a browser:
1. Load the site. Confirm the yellow "Demo mode" banner is **absent**
   and real market cards render.
2. Open devtools → Network. Filter for `api/dflow` — all calls should
   be same-origin (`trade.yourdomain.com`) and return 200.
3. Connect a Solana wallet. Try a $1 market trade. Watch the Pages
   dashboard → **Functions → Real-time logs** for any Function errors.
4. Place a limit order. Confirm the persistent "Pending orders" banner
   appears (expected — conditional orders run client-side).

#### Step 8 — Local testing with Wrangler (optional)

Before pushing changes to the Function or `_headers`/`_redirects`,
test them locally with Wrangler:

```bash
npx wrangler pages dev dist \
  --binding DFLOW_UPSTREAM=https://dev-prediction-markets-api.dflow.net \
  --compatibility-date=2026-04-21
```

Wrangler serves `dist/` on `http://localhost:8788` and executes
`functions/` against the local runtime — close enough to production to
debug proxy behavior without a preview deploy. Run `npm run build`
first so `dist/` is fresh.

#### Step 9 — Rollback

If a deploy goes bad:
1. Project → **Deployments** tab.
2. Pick the last known-good deploy.
3. Click **⋯ → Rollback to this deployment**.

Rollback is instant (no rebuild). Env-var changes are versioned with
the deployment, so a rollback also restores the variable set that was
active at the time.

#### Step 10 — Keep it deployed

- **Auto-deploy on push:** every commit to `main` → production.
  Every push to any other branch → a preview URL at
  `https://<branch>.predictflow.pages.dev`.
- **Auto-deploy on PR:** opens a preview comment on the PR with the
  unique deploy URL.
- **Branch protection:** pair the Cloudflare preview with the existing
  GitHub Actions CI (`npm test`, `npm run size`) so broken builds never
  get merged to `main`.

### Setting up the KYC backend

PredictFlow's `useKyc` delegates to a backend you own. The contract:

```
POST $VITE_KYC_CHECK_URL
Content-Type: application/json

{ "wallet": "<base58-pubkey>" }

→ 200 OK
  { "verified": true,  "expiresAt": "2026-05-01T00:00:00Z" }
  { "verified": false }
```

`useKyc` calls this at mount and after every wallet change, plus
just-in-time before every trade/limit/SL/TP/DCA submit. Keep response time
under 2s; a 6s client-side timeout applies (1 retry).

### Setting up the live-price feed

Two paths:

- **WebSocket** (preferred) — set `VITE_DFLOW_WS_URL`. `useLivePrices`
  subscribes to visible market tickers, reconnects with exponential
  backoff + circuit breaker.
- **REST fallback** — set `VITE_LIVE_PRICE_URL=https://your-host/live/{eventTicker}`.
  Every pending conditional order polls this URL every 5s. `{eventTicker}`
  is URL-encoded before substitution.

Without either, the conditional-order engine can't trigger (no prices →
no comparisons). In prod with only limit orders and no WS, you must set
`VITE_LIVE_PRICE_URL`.

---

## Security model

### Transaction signing

Every signed transaction goes through four defenses in order:

```
DFlow /order response
  │
  ▼
validateTxPayload(tx)     ← reject payloads bigger than 2 × MAX_TX_SIZE
  │
  ▼
decodeDflowTransaction(tx)  ← parse via @solana/web3.js
  │
  ▼
assertAllowedPrograms(tx)   ← every instruction must target a whitelisted program:
  │                             - System
  │                             - SPL Token + ATA
  │                             - ComputeBudget
  │                             - Memo
  │                             - VITE_DFLOW_ALLOWED_PROGRAMS (router)
  │
  ▼
preflightTransaction(tx)    ← simulateTransaction on Solana RPC
  │                           (sigVerify:false, replaceRecentBlockhash:true)
  │                           fails closed if RPC unreachable
  ▼
wallet.signAndSendTransaction(tx)
```

If any step fails the user sees an explicit error, never the signing prompt.

### CSP

`index.html` ships a strict `Content-Security-Policy`:
- `default-src 'self'`
- `script-src 'self'` (no inline scripts; the Eitherway dev harness is
  DEV-only)
- `connect-src` enumerates DFlow, Solana RPC, optional Sentry / PostHog
- `img-src`/`font-src` permit Google Fonts + self

### localStorage isolation

- `safeGet` / `safeSet` swallow quota errors.
- `withPositionsLock` serializes concurrent writes across TradePanel,
  `useDCA`, and `useConditionalOrders` via a promise chain. Writing
  `predictflow_positions` from anywhere else would break this invariant.
- `runMigrations()` bumps `predictflow_storage_version` and lets you
  write forward-migration code in one place.

### Privacy

- Wallet pubkeys in analytics events are always SHA-256-hashed via
  `lib/privacy.js#hashWallet`.
- `safeErrorMessage` strips HTML + control chars from errors before they
  reach Sentry.

---

## Testing

Vitest + jsdom. 53 tests across 11 files as of last snapshot.

```bash
npm test                         # all tests, one-shot
npm run test:watch               # watch mode
npm test -- src/lib/…            # path filter
npm test -- -t 'regex'           # name filter
```

Categories under coverage:
- `lib/` — pure utilities (`storage`, `triggers`, `format`, `normalize`,
  `privacy`, `errorMessage`, `http`, `dateFormat`, `txDecoder`)
- `hooks/useKyc` — stateful context + missing-provider tolerance
- `App.test.jsx` — smoke render with fetch/WebSocket stubbed

When you add a new pure helper under `lib/`, add a sibling `.test.js`.
When you add a new context hook, add a smoke-render test under `hooks/`.

---

## Troubleshooting

**"Demo mode" banner stuck on.**
`useMarkets` can't reach `/api/dflow/…/events`. Check that the proxy is
live (curl `http://localhost:5173/api/dflow/api/v1/events?limit=1` in dev
or the prod-host equivalent). Network errors are reported to Sentry if
`VITE_SENTRY_DSN` is set.

**"This market has no tradeable outcome mint yet."**
DFlow hasn't published YES/NO mints for that market yet. You can still
watch price and depth. If you're on a demo environment, flip
`VITE_ALLOW_SYNTHESIZED_MINTS=true` — but again, only for demos.

**"Could not verify order with Solana RPC."**
All RPC endpoints in `VITE_SOLANA_RPC_ENDPOINTS` were unreachable during
preflight. The signing prompt is intentionally blocked — we don't want
to sign something we haven't simulated. Add a paid RPC or retry.

**Wallet connects but trades never go through.**
Open devtools → Network. Look at `/order` and the subsequent
`assertAllowedPrograms` / preflight error. The most common cause in a
fresh install is that `VITE_DFLOW_ALLOWED_PROGRAMS` is empty and the
router program ID isn't in the baseline whitelist. Add the DFlow router
program ID there.

**Conditional orders never trigger.**
In prod with neither `VITE_DFLOW_WS_URL` nor `VITE_LIVE_PRICE_URL` set,
there's no price feed. Set one. (In dev the simulated-drift path only
runs when `VITE_ALLOW_SIMULATED_FILLS=true`.)

**Pending orders / active DCA don't execute after I closed the tab.**
By design — everything runs in the browser. There's a persistent banner
reminding the user. A real deployment needs a server-side scheduler to
execute orders while users are offline.

**Build is over budget in CI.**
`npm run size` enforces per-chunk gzipped budgets in
`scripts/check-bundle-size.mjs`. Adjust the entry there if the new budget
is intentional, otherwise find what bloated the chunk. Common culprits:
importing a heavy package at the top level instead of behind `lazy()`.

---

## Related docs

- `docs/eitherway-platform.md` — notes on the Eitherway export origin
  (host harness, known export quirks, template lineage).
- `.env.example` — canonical list of every `VITE_*` var.
