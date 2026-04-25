# PredictFlow

A terminal-styled prediction-market frontend for Solana. Browse event/market
data, connect a Solana wallet, and place market, limit, stop-loss,
take-profit, or DCA trades that settle through the DFlow quote/order API.

PredictFlow is a **static SPA** plus a thin Cloudflare Pages Function that
reverse-proxies the DFlow API and injects the DFlow API key on the edge.
The browser bundle never sees the upstream host or the key — it only ever
talks to same-origin `/api/dflow*` paths. Solana RPC and the DFlow
WebSocket are still hit directly from the browser.

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
          │ /api/dflow*    │ wss://…dflow.net/ws  │ Solana RPC
          ▼                ▼                      ▼
   ┌────────────────────────┐   ┌──────────┐  ┌──────────────────┐
   │ Cloudflare Pages       │   │ DFlow WS │  │ Solana RPC       │
   │ Function               │   │ (live    │  │ (balance scan +  │
   │ + Authorization header │   │  prices) │  │  tx preflight)   │
   │ from env.DFLOW_API_KEY │   └──────────┘  └──────────────────┘
   └───────────┬────────────┘
               │
               ├─▶ DFlow REST   (events, orderbook, trades, candles)
               ├─▶ DFlow quote  (USDC → outcome-mint price)
               └─▶ DFlow order  (returns a Solana tx for the wallet to sign)

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
4. [Monetization & fees](#monetization--fees)
5. [localStorage schema](#localstorage-schema)
6. [Environment variables](#environment-variables)
7. [Local development](#local-development)
8. [Production deployment](#production-deployment)
9. [Security model](#security-model)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)

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
- **Market** — USDC → outcome-mint swap via the same-origin
  `/api/dflow-quote` + `/api/dflow-order` proxies (the Pages Function
  forwards to DFlow's quote-api with the API key attached), signed by an
  injected Solana wallet.
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

**Monetization**
- Three subscription tiers (Free / Pro / Whale) with per-tier swap-fee
  rates (0.30% / 0.15% / 0.05%) deducted before DFlow sees the order.
- Fee transfer is a second wallet-signed SPL USDC tx targeting
  `VITE_FEE_WALLET`, with an optional 20% split to a referrer.
- Pricing page (`/#/pricing`), upgrade modal that pays subscription in
  USDC, hidden revenue dashboard at `/#/admin/revenue` for the fee
  wallet operator. See [Monetization & fees](#monetization--fees).

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
fetchWithRetry GET /api/dflow-order?inputMint=USDC&outputMint=YES&amount=…
                        X-Idempotency-Key: mkt-<uuid>
        │  Pages Function adds Authorization: Bearer <DFLOW_API_KEY>
        │  and forwards to https://quote-api.dflow.net/order
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

## Monetization & fees

PredictFlow's revenue model has three layers. Each one stacks; turn off
any of them by leaving the corresponding env var or UI surface unused.

### Tier table

Defined in `src/config/fees.js` (`FEE_CONFIG.TIERS`).

| Tier   | Swap fee | Conditional orders | DCA | Subscription (USDC/mo) |
| ------ | -------- | ------------------ | --- | ---------------------- |
| Free   | 0.30%    | 1 active           | ✗   | $0                     |
| Pro    | 0.15%    | up to 10           | ✓   | $9.99                  |
| Whale  | 0.05%    | unlimited          | ✓   | $29.99                 |

Tier rates are basis points. Trades below `MIN_TRADE_FOR_FEE` ($1.00 USDC)
are waived so the on-chain transfer cost doesn't dominate the fee.

### Fee flow on every trade

```
User enters $100, FREE tier, no referrer
        │
        ▼
calculateFee(100, 'FREE') → { feeAmount: 0.30, netAmount: 99.70 }
        │
        ▼
DFlow /order called with amount = 99.70 USDC          (1st sign)
        │   user signs the swap; net amount enters DFlow router
        ▼
Wallet still holds $0.30 in its USDC ATA
        │
        ▼
buildFeeTransferTransaction({ transfers: [
  { to: VITE_FEE_WALLET, amount: 0.30 },              (2nd sign)
  // + { to: referrer, amount: 0.06 } when applicable
]})
        │   user signs the fee sweep
        ▼
logFeeEvent({ tier, feeAmount, platformAmount, ... })
appendPosition({ amount: 100, netAmount: 99.70, feeAmount: 0.30 })
```

The fee sweep is a **separate, best-effort** legacy `Transaction`. If it
fails, the swap already settled — the trade is recorded, the failure is
logged with `feeStatus: 'failed'`, and the user sees a non-blocking
notice. We never roll the trade back.

The SPL Transfer + idempotent ATA-create instructions are built by hand
in `src/lib/feeTransfer.js` (no `@solana/spl-token` dependency added —
the project keeps `@solana/web3.js` as the only Solana lib).

### Referral split

- Code = first 8 characters of the wallet pubkey.
- Each connecting wallet auto-registers itself in
  `predictflow_referral_registry` so any visitor's `?ref=<code>` URL
  resolves back to a payable pubkey.
- Captured `?ref=` is sticky: the first value seen is stored in
  `predictflow_referrer` and never overwritten on subsequent visits.
- Self-referrals are filtered out (a user clicking their own link
  earns nothing).
- When a referrer is active, 20% of the fee (`REFERRAL_SHARE_PERCENT`)
  is paid to them as a second `SplToken::Transfer` instruction in the
  same fee-sweep transaction. Earnings are tracked in
  `predictflow_referral_earnings`.

### Tier persistence (MVP vs. production)

| Concern         | MVP (this repo)                                                | Production path                                       |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Where tier lives | `localStorage` keyed by wallet pubkey                          | On-chain subscription program *or* signed JWT         |
| Expiry check     | 30-day timestamp in `predictflow_tier_expires_<pubkey>`        | Same, but server-attested                             |
| Per-device sync  | None — clear local data, lose tier                             | On-chain or server-side, follows the wallet           |
| Receipt          | Local fee log entry (`kind: 'subscription'`)                   | On-chain tx + invoice                                 |

`getUserTier(pubkey)` enforces expiry on read and downgrades a lapsed
sub back to Free. The `useUserTier` hook re-reads on a custom
`predictflow:tier-change` event so all components in the same tab sync
without polling.

### Configuration

The only required env var is `VITE_FEE_WALLET` — the Solana pubkey that
receives platform swap fees and subscription payments. When unset (or
left at the placeholder `PredictFLowFeeWa11etConfigureMeP1ease111111`):

- Trade flow records the *intended* fee in `predictflow_fee_log` with
  `feeStatus: 'failed'` and a "fee wallet not configured" reason.
- The pricing modal surfaces a clear demo-mode banner.
- The admin revenue dashboard still shows aggregated would-be revenue
  so judges/stakeholders can see the model without a real wallet.

This makes the system safe to demo without touching real funds.

### Admin revenue dashboard

Hidden page at `/#/admin/revenue`. Authorization rule:

- If `VITE_FEE_WALLET` is configured: only the connected wallet that
  matches `FEE_CONFIG.FEE_WALLET` can view real numbers.
- If unconfigured (demo): any connected wallet sees the dashboard with
  a "demo mode" banner overlay.

Stats come from `predictflow_fee_log` (capped to 1000 entries, oldest
roll off):

- Total fees, today / week / month
- Trade count + average fee per trade
- Tier distribution (% of trades by tier)
- Recent events table with status (`sent` / `failed` / `subscription`)

There's a **Clear log** button — destructive, no confirmation. Don't
expose the route publicly in prod without locking it to a server-side
auth check; the client-side wallet check is a soft gate, not a security
boundary.

### UI surfaces

| Component / page                       | File                                                            | Purpose                                                          |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `FeeBreakdown`                         | `src/components/monetization/FeeBreakdown.jsx`                  | Pre-trade transparency block in TradePanel quote area            |
| `TierBadge`                            | `src/components/monetization/TierBadge.jsx`                     | Free/Pro/Whale chip in header (click → opens pricing)            |
| `UpgradeModal`                         | `src/components/monetization/UpgradeModal.jsx`                  | Pays monthly subscription via SPL USDC transfer                  |
| `UpgradeNudge`                         | `src/components/monetization/UpgradeNudge.jsx`                  | Inline + lock-overlay variants for contextual upsells            |
| `PricingCards`, `PricingPage`          | `src/components/monetization/PricingCards.jsx`, `src/pages/PricingPage.jsx` | Three-tier comparison + FAQ at `/#/pricing`                |
| `ReferralSection`                      | `src/components/monetization/ReferralSection.jsx`               | Invite link + earnings stats inside Portfolio                    |
| `FeeDisclosure`                        | `src/components/monetization/FeeDisclosure.jsx`                 | Footer transparency line on Explore + Pricing                    |
| `AdminRevenuePage`                     | `src/pages/AdminRevenuePage.jsx`                                | `/#/admin/revenue` ops dashboard                                 |

### Hooks & services

| Module                                   | Role                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `src/services/feeService.js`             | `calculateFee`, `getUserTier`, `setUserTier`, tier gates                 |
| `src/services/referralService.js`        | Capture `?ref=`, registry, earnings, self-referral filter                |
| `src/lib/feeTransfer.js`                 | SPL Transfer + ATA helpers, fee-sweep transaction builder                |
| `src/lib/feeLog.js`                      | Append-only fee event log + summarizer                                   |
| `src/hooks/useUserTier.js`               | Subscribes to `predictflow:tier-change` for cross-component sync         |
| `src/hooks/useReferral.js`               | Exposes connected wallet's code, link, stats, active referrer            |
| `src/hooks/useUpgradeModal.jsx`          | Single top-level modal so any nudge can `open(tier)` without prop drill  |

### Tier gating in code

```js
import { canUseDCA, canCreateConditionalOrder } from '../services/feeService'

// DCA tab — Free tier sees a locked overlay instead of the form
if (!canUseDCA(tier)) return <UpgradeNudge variant="lock" … />

// Limit / SL / TP form — Free tier can place 1 active order
const { allowed, reason } = canCreateConditionalOrder(tier, pendingOrders.length)
if (!allowed) return <UpgradeNudge tone="yellow" message={reason} … />
```

---

## localStorage schema

Single source of truth. Keep this table up to date — add a row when you
introduce a new client-persistent key.

| Key                                       | Schema version | Purpose                                                                          |
| ----------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `predictflow_markets_cache`               | 2              | 60s events/markets cache                                                         |
| `predictflow_conditional_orders`          | 2              | Pending / filled / cancelled limit/SL/TP orders                                  |
| `predictflow_dca_strategies`              | 2              | Active / completed / cancelled DCA strategies + execution history                |
| `predictflow_positions`                   | 2              | Filled trade positions (gates SL/TP tabs in TradePanel)                          |
| `predictflow_wallet`                      | —              | Restored wallet pubkey on reload                                                 |
| `predictflow_wallet_id`                   | —              | Restored wallet adapter id (`phantom` / `solflare` / `backpack`)                 |
| `predictflow_kyc_status`                  | —              | `unverified` / `pending` / `verified`                                            |
| `predictflow_storage_version`             | —              | Migration tracker; `runMigrations()` runs on app boot                            |
| `predictflow_tier_<pubkey>`               | —              | Active tier (`PRO` / `WHALE`) for that wallet                                    |
| `predictflow_tier_expires_<pubkey>`       | —              | Subscription expiry timestamp (ms since epoch); read-time downgrade if past      |
| `predictflow_referrer`                    | —              | First-seen `?ref=` code (sticky for this device)                                 |
| `predictflow_referral_registry`           | —              | `{ [code]: pubkey }` map populated when wallets connect                          |
| `predictflow_referral_earnings`           | —              | `{ [pubkey]: { earned, count } }` accumulating referral payouts                  |
| `predictflow_fee_log`                     | —              | Append-only fee/subscription event log (capped at 1000)                          |

---

## Environment variables

There are two flavors of env var in this repo:

- **`VITE_*`** — read in client code (`src/config/env.js`) and **inlined
  into the browser bundle** at build time. Never put a secret here.
- **No-prefix** (e.g. `DFLOW_UPSTREAM`, `DFLOW_API_KEY`) — read by
  `vite.config.js` (dev proxy) and the Cloudflare Pages Functions
  (prod proxy). **Never enter `import.meta.env`, never reach the bundle.**
  Secrets like `DFLOW_API_KEY` belong here.

Copy `.env.example` → `.env.local` for local dev. In prod (Cloudflare
Pages), set the same names in the dashboard.

### DFlow — server-side (proxy + auth, never in the bundle)

| Var | Default | Notes |
| --- | --- | --- |
| `DFLOW_UPSTREAM` | `https://dev-prediction-markets-api.dflow.net` | Where `/api/dflow/*` (REST) is forwarded. **Prod:** `https://prediction-markets-api.dflow.net`. |
| `DFLOW_QUOTE_UPSTREAM` | `https://dev-quote-api.dflow.net/quote` | Where `/api/dflow-quote` is forwarded. **Prod:** `https://quote-api.dflow.net/quote`. |
| `DFLOW_ORDER_UPSTREAM` | `https://dev-quote-api.dflow.net/order` | Where `/api/dflow-order` is forwarded. **Prod:** `https://quote-api.dflow.net/order`. |
| `DFLOW_API_KEY` | *empty* | DFlow auth key. Injected by the Pages Functions on every upstream call. **Set as Secret in prod.** Never give this a `VITE_` prefix. |
| `DFLOW_API_KEY_HEADER` | `Authorization` | If `Authorization`, the helper sends `Authorization: Bearer <key>`. With any other header name (e.g. `x-api-key`) it sends the raw key. |

### DFlow — client (same-origin proxy paths, safe in the bundle)

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_DFLOW_PROXY_BASE` | `/api/dflow` | Base path used by `useMarkets`, `useHealth`, `RecentTrades`, `CandlestickChart`, `DepthChart`, `usePortfolio`. |
| `VITE_DFLOW_QUOTE_URL` | `/api/dflow-quote` | Endpoint hit by `useTradeSubmit#previewQuote`. Default is the same-origin proxy. |
| `VITE_DFLOW_ORDER_URL` | `/api/dflow-order` | Endpoint hit by `useTradeSubmit`, `useDCA`, `useConditionalOrders`. Default is the same-origin proxy. |
| `VITE_DFLOW_WS_URL` | `wss://api.prod.dflow.net/ws` | WebSocket goes browser-direct (no proxy). Leave empty to disable. |
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

### Monetization

| Var | Default | Notes |
| --- | --- | --- |
| `VITE_FEE_WALLET` | *placeholder (`PredictFLowFeeWa11etConfigureMeP1ease111111`)* | Solana pubkey that receives platform swap fees and tier subscription payments. When unset, fee transfers are skipped and the admin dashboard shows "recorded intent" only — safe for demos. **Required for on-chain revenue.** See [Monetization & fees](#monetization--fees). |

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
- Markets catalog via the Vite dev proxy → `DFLOW_UPSTREAM` (dev DFlow
  host). Quote/order go through the dev proxy too — `DFLOW_QUOTE_UPSTREAM`
  and `DFLOW_ORDER_UPSTREAM`.
- Wallet connect/disconnect.
- All UI flows. Trades against the dev DFlow endpoints require real USDC
  on whichever cluster your `VITE_SOLANA_RPC_ENDPOINTS` points at — by
  default, mainnet.

If your dev DFlow cluster requires an API key, set `DFLOW_API_KEY` in
`.env.local`. Vite's `loadEnv('', cwd)` picks it up but does **not**
inject it into the bundle — `vite.config.js` reads it server-side and
the dev proxy forwards it as the `Authorization` header. The same name
works in Cloudflare Pages, so `.env.local` stays 1:1 with prod env vars.

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
DFLOW_UPSTREAM=https://invalid.local
DFLOW_QUOTE_UPSTREAM=https://invalid.local
DFLOW_ORDER_UPSTREAM=https://invalid.local
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

- [ ] `DFLOW_UPSTREAM`, `DFLOW_QUOTE_UPSTREAM`, `DFLOW_ORDER_UPSTREAM` set
      to the prod hosts (`prediction-markets-api.dflow.net` and
      `quote-api.dflow.net`).
- [ ] `DFLOW_API_KEY` set as a **Secret** in the Cloudflare Pages
      dashboard. **No `VITE_` prefix.**
- [ ] `DFLOW_API_KEY_HEADER` set if DFlow expects something other than
      `Authorization: Bearer …` (default).
- [ ] `VITE_DFLOW_QUOTE_URL=/api/dflow-quote` and
      `VITE_DFLOW_ORDER_URL=/api/dflow-order` (defaults — don't override
      to absolute DFlow URLs in prod).
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
- [ ] `dist/assets/*.js` does **not** contain the API key or the
      DFlow upstream hostnames (sanity-grep before deploying):
      `grep -E 'prediction-markets-api|quote-api\.dflow|<your key prefix>' dist/assets/*.js`
      should return nothing.
- [ ] Legal copy (`VITE_TERMS_URL`, `VITE_RISK_URL`, etc.) points to real
      pages.
- [ ] `VITE_FEE_WALLET` set to a Solana pubkey you control (not the
      placeholder). Confirm a $1 trade in preview triggers a second
      signed tx that sweeps the fee — see [Monetization & fees](#monetization--fees).

> **Note on non-Cloudflare hosts.** The repo's primary deployment target
> is Cloudflare Pages — the `functions/api/dflow*` Pages Functions
> inject `DFLOW_API_KEY` server-side. The Vercel / Netlify / Nginx
> configs in this repo only handle the REST proxy, **not** the quote/order
> proxy and **not** API-key injection. To use any of them in prod you
> need to add an equivalent serverless function (Vercel Edge Function,
> Netlify Function, or an upstream auth-injecting server) for
> `/api/dflow-quote` and `/api/dflow-order`, and add the same
> `Authorization: Bearer …` header to the REST proxy.

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
3. Add environment variables under Settings → Environment Variables.
   At minimum: all `VITE_DFLOW_*`, `VITE_SOLANA_RPC_ENDPOINTS`,
   `VITE_KYC_CHECK_URL`, `VITE_DFLOW_ALLOWED_PROGRAMS`.
4. The shipped `vercel.json` only rewrites `/api/dflow/*` to a static
   destination and does **not** add an auth header or proxy quote/order.
   Replace it with three Vercel Edge Functions (or migrate to Cloudflare
   Pages — see Option E) that implement the same logic as
   `functions/api/dflow*` in this repo, reading `DFLOW_UPSTREAM`,
   `DFLOW_QUOTE_UPSTREAM`, `DFLOW_ORDER_UPSTREAM`, and `DFLOW_API_KEY`.
5. Deploy. Headers (HSTS preload, COOP, CORP, etc.) are already configured.

Already done for you in `vercel.json`:
- SPA fallback (`/((?!…).*)` → `/index.html`)
- Immutable caching for hashed assets
- Security headers (`X-Content-Type-Options`, HSTS preload, COOP, CORP, …)

### Option B — Netlify

1. Push to GitHub → Netlify → Import.
2. Build command: `npm run build`. Publish directory: `dist`.
3. Add env vars under Site settings → Environment variables.
4. The shipped `netlify.toml` redirect for `/api/dflow/*` is
   key-injection-less. Add three Netlify Functions for
   `/api/dflow/*`, `/api/dflow-quote`, and `/api/dflow-order` that
   forward to the upstream hosts and attach `Authorization: Bearer
   $DFLOW_API_KEY` (mirror `functions/_lib/dflow-proxy.js`).
5. Deploy.

### Option C — Self-hosted Nginx

1. `npm run build` on your build host (or in CI).
2. Copy `dist/` to `/var/www/predictflow/dist`.
3. Drop `deploy/nginx.conf` into `/etc/nginx/sites-available/`. Edit:
   - `server_name`
   - `proxy_pass` in the `/api/dflow/` block — point at prod DFlow REST
   - Add a `proxy_set_header Authorization "Bearer $DFLOW_API_KEY";` line
     (set `$DFLOW_API_KEY` via `env DFLOW_API_KEY;` + `set_by_lua_block`,
     or hardcode in a `.conf` excluded from VCS).
   - Add equivalent `location /api/dflow-quote` / `location /api/dflow-order`
     blocks pointing at `https://quote-api.dflow.net/quote` and `/order`.
   - Add a TLS cert (certbot or equivalent).
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
| `functions/_lib/dflow-proxy.js` | Shared helper — strips hop-by-hop headers, injects `DFLOW_API_KEY` |
| `functions/api/dflow/[[path]].js` | `/api/dflow/*` reverse proxy → `DFLOW_UPSTREAM` |
| `functions/api/dflow-quote.js` | `/api/dflow-quote` reverse proxy → `DFLOW_QUOTE_UPSTREAM` |
| `functions/api/dflow-order.js` | `/api/dflow-order` reverse proxy → `DFLOW_ORDER_UPSTREAM` |

```
┌──────────┐   /api/dflow/*       ┌─────────────────────────┐
│ Browser  │ ───────────────────▶ │ Pages Function          │ ─▶ DFlow REST
│          │   /api/dflow-quote   │ + Authorization header  │ ─▶ DFlow quote
│          │   /api/dflow-order   │ from env.DFLOW_API_KEY  │ ─▶ DFlow order
└──────────┘                      └─────────────────────────┘
       │ /*
       └────────────────────────▶ dist/index.html  (SPA fallback via _redirects)
```

The browser bundle only references same-origin `/api/dflow*` paths — the
DFlow upstream hosts and the API key live exclusively on the edge runtime.

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

**Runtime — consumed by the Pages Functions and the build runner. Server-side only — never inlined into the bundle:**

| Variable | Production value | Notes |
| --- | --- | --- |
| `DFLOW_UPSTREAM` | `https://prediction-markets-api.dflow.net` | **Required.** REST host for markets/events. The `/api/dflow/*` proxy forwards here. |
| `DFLOW_QUOTE_UPSTREAM` | `https://quote-api.dflow.net/quote` | **Required.** Quote endpoint. The `/api/dflow-quote` proxy forwards here. |
| `DFLOW_ORDER_UPSTREAM` | `https://quote-api.dflow.net/order` | **Required.** Order endpoint. The `/api/dflow-order` proxy forwards here. |
| `DFLOW_API_KEY` | `<prod key from DFlow team>` | **Required & Secret.** Injected by the Pages Functions as the auth header on every upstream call. **Never** add a `VITE_` prefix to this — it would leak into the bundle. |
| `DFLOW_API_KEY_HEADER` | `Authorization` *(default)* | Optional. Set to `x-api-key` (or whatever DFlow expects) if `Authorization: Bearer …` is wrong. With the default, the helper sends `Authorization: Bearer <DFLOW_API_KEY>`; with any other header name it sends the raw key. |
| `NODE_VERSION` | `20` | **Required.** Matches `.github/workflows/ci.yml`. |

**Build-time — inlined into the client bundle (VITE_*). Must contain no secrets:**

| Variable | Production value |
| --- | --- |
| `VITE_DFLOW_PROXY_BASE` | `/api/dflow` |
| `VITE_DFLOW_QUOTE_URL` | `/api/dflow-quote` *(same-origin proxy, no upstream host in the bundle)* |
| `VITE_DFLOW_ORDER_URL` | `/api/dflow-order` *(same-origin proxy, no upstream host in the bundle)* |
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
| `VITE_FEE_WALLET` | `<your Solana pubkey>` — receives swap fees and subscription payments. Leave unset only for revenue-disabled demos. |
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
| `DFLOW_QUOTE_UPSTREAM` | `https://dev-quote-api.dflow.net/quote` |
| `DFLOW_ORDER_UPSTREAM` | `https://dev-quote-api.dflow.net/order` |
| `DFLOW_API_KEY` | `<dev key from DFlow team, if required>` *(Secret)* |
| `VITE_ALLOW_SIMULATED_FILLS` | `true` *(optional — OK for QA, never in prod)* |

`VITE_DFLOW_QUOTE_URL` and `VITE_DFLOW_ORDER_URL` should stay as
`/api/dflow-quote` and `/api/dflow-order` in Preview too — only the
*upstream* env vars change between environments.

Everything else (KYC, RPC, Proof, legal URLs) can point at the same
values as production, or at dedicated staging endpoints if you have them.

#### Step 5 — Trigger the first deploy

Click **Save and Deploy**. Cloudflare will:

1. Clone the repo on the chosen branch.
2. Run `npm ci && npm run build` with your env vars exposed to Vite.
3. Upload `dist/` to the global edge cache.
4. Deploy `functions/api/dflow/[[path]].js`, `functions/api/dflow-quote.js`, and `functions/api/dflow-order.js` to the Workers runtime.
5. Publish at `https://predictflow.pages.dev` (unique per project).

First build takes ~90–150 seconds. Watch the **Build log** tab for errors.
Common failures on first deploy:
- **`npm error EBADENGINE`** → `NODE_VERSION` is missing or wrong.
- **Blank markets list after deploy** → `DFLOW_UPSTREAM` not set, or
  `DFLOW_API_KEY` missing/invalid (DFlow returns 401/403; the proxy
  forwards the status as-is).
- **Trade fails with "Order API unavailable" / 401 / 403** →
  `DFLOW_QUOTE_UPSTREAM` / `DFLOW_ORDER_UPSTREAM` not set, or
  `DFLOW_API_KEY` wrong, or `DFLOW_API_KEY_HEADER` doesn't match what
  DFlow expects (try `x-api-key` if `Authorization` fails).
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
  --binding DFLOW_QUOTE_UPSTREAM=https://dev-quote-api.dflow.net/quote \
  --binding DFLOW_ORDER_UPSTREAM=https://dev-quote-api.dflow.net/order \
  --binding DFLOW_API_KEY=<your dev key> \
  --compatibility-date=2026-04-21
```

Wrangler serves `dist/` on `http://localhost:8788` and executes
`functions/` against the local runtime — close enough to production to
debug proxy behavior (including key injection) without a preview deploy.
Run `npm run build` first so `dist/` is fresh.

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

### DFlow API key isolation

The DFlow API key never reaches the browser. The browser bundle only
references same-origin `/api/dflow*` paths; the upstream hostnames and
the key live exclusively in:

- **Prod:** Cloudflare Pages env (server-side), read at request time by
  the Pages Functions in `functions/api/`.
- **Dev:** `.env.local` (no `VITE_` prefix), read at server-startup time
  by `vite.config.js` and attached to the dev proxy headers.

The shared helper at `functions/_lib/dflow-proxy.js` also rejects
non-GET/HEAD/OPTIONS verbs, so a compromised frontend bundle cannot
turn the proxy into a blind relay for state-changing requests. To
verify the bundle has no leak, run after a build:

```bash
grep -E "prediction-markets-api|quote-api\.dflow|<your key prefix>" \
  dist/assets/*.js
# Expected: no matches.
```

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

Vitest + jsdom. 103 tests across 15 files as of last snapshot.

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

**Trade signs but no fee transfer pops up.**
Either `VITE_FEE_WALLET` isn't set (placeholder ⇒ fee transfer is
skipped by design — check `predictflow_fee_log` for `feeStatus: 'failed'`
entries), or the wallet rejected the second signing prompt. Both are
recoverable: the swap already settled. Set `VITE_FEE_WALLET` and retry,
or check the admin revenue page at `/#/admin/revenue` for the event.

**Pricing modal shows "Subscription wallet not configured".**
Same root cause — `VITE_FEE_WALLET` is unset or still on the placeholder.
Set it to your Solana pubkey, redeploy, and the upgrade flow will accept
real USDC payments.

**Build is over budget in CI.**
`npm run size` enforces per-chunk gzipped budgets in
`scripts/check-bundle-size.mjs`. Adjust the entry there if the new budget
is intentional, otherwise find what bloated the chunk. Common culprits:
importing a heavy package at the top level instead of behind `lazy()`.

---

## Related docs

- `docs/eitherway-platform.md` — notes on the Eitherway export origin
  (host harness, known export quirks, template lineage).
- `.env.example` — canonical list of every env var (server-side
  `DFLOW_*` proxy targets / API key, plus client-side `VITE_*`).
- `functions/_lib/dflow-proxy.js` — single source of truth for how the
  Pages Functions strip headers and inject the DFlow auth header.
