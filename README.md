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

Hook your static host (Cloudflare Pages, S3+CloudFront, Render,
Azure Static Web Apps, …) to either the repo or the artifact.

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

- `CLAUDE.md` — working notes for LLM-assisted edits (architecture
  pointers and safety flags).
- `docs/eitherway-platform.md` — notes on the Eitherway export origin.
- `.env.example` — canonical list of every `VITE_*` var.
