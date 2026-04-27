# Eitherway Platform — Reference Notes

Context for fixing and extending this project. `predictflow` was scaffolded by Eitherway and exported; several quirks in the repo (the malformed `package.json`, the host-injected `scripts/*.js`, the Solana wallet code) come from that origin.

## What Eitherway is

An AI app-builder focused on the Solana ecosystem. You describe an app in natural language and the platform generates a working codebase you can preview in-browser, iterate on, and deploy.

Marketing tagline: *"Don't just imagine it. Launch it."*

- Homepage: https://eitherway.ai
- Chat / builder: https://eitherway.ai/chat
- Templates: https://eitherway.ai/templates
- Docs: https://docs.eitherway.ai

## Four-stage workflow

1. **Describe** — natural-language chat.
2. **Generate** — the platform produces frontend components, backend logic, and blockchain integrations. Solana smart contracts are generated as Rust/Anchor, described as "mainnet-ready."
3. **Test** — live preview in the browser inside Eitherway's editor shell (see "Host harness" below).
4. **Deploy** — to app stores, web hosting, or Solana mainnet.

## Supported output targets

- Web / SaaS apps (this repo is one — React + Vite SPA)
- Mobile apps
- Browser extensions
- Solana dApps

## Solana integration

- Wallet support is via browser-injected providers — **Phantom** (`window.solana`) and **Solflare** (`window.solflare`). No `@solana/wallet-adapter-*` packages. `src/hooks/useWallet.jsx` follows this pattern.
- Transactions are priced on Solana mainnet (~400ms, sub-cent fees).
- Generated on-chain code targets Anchor.

## Templates (categories)

- **DeFi / Finance** — yield optimizers, portfolio trackers, token deployment
- **NFTs / Gaming** — marketplaces, P2E reward trackers
- **Infrastructure** — DAO governance, escrow apps, project sites

`predictflow` appears to derive from the DeFi / markets template family.

## Pricing / `EITHER` token

No traditional SaaS tiers are public. Premium features, exclusive templates, and governance are gated behind the **EITHER** token (issued on Solana).

## Host harness — why the `scripts/` directory exists

When an Eitherway-generated app runs inside the platform's preview iframe, three scripts get injected via `index.html`:

| File | Purpose |
| --- | --- |
| `scripts/runtime-error-reporter.js` | Captures `window.error`, unhandled promise rejections, React error-boundary logs, and Vite build-overlay errors, then `postMessage`s them to `window.parent` (Eitherway's editor). |
| `scripts/vite-error-monitor.js` | Watches the Vite HMR error overlay and forwards build failures. |
| `scripts/component-inspector.js` | Exposes DOM / component introspection hooks to the parent editor. |

These are harmless outside the platform (the parent frame simply isn't there), but they're load-bearing inside it. Don't delete them unless you're fully decoupling from Eitherway.

## Known rough edges from the export

Things the Eitherway export left broken or awkward in this repo — flag these when fixing:

1. **`package.json` is malformed.** It contains only the `dependencies` / `devDependencies` blocks with no outer `{…}` and no `scripts` field. `npm install` fails until repaired. Likely Eitherway fills these in at preview time and they don't survive the export. **First thing to fix before anything else.**
2. **`/api/dflow` proxy is dev-only.** `vite.config.js` proxies `/api` → `http://localhost:3001`. There's no backend in this repo. DFlow calls in `src/hooks/useMarkets.jsx` depend on this proxy; production deployment needs either a real edge proxy or direct-to-DFlow URLs with CORS.
3. **Conditional orders use a fake price feed.** `src/hooks/useConditionalOrders.jsx::fetchLivePrice` returns random drift, not real prices. The intended endpoint (`/api/v1/live_data/by-event/{event_ticker}`) is noted in the source comment but not wired up.
4. **YES / NO token mints are placeholders.** `src/components/TradePanel.jsx::getTokenMint` returns `YES-<marketId>-mint` / `NO-<marketId>-mint` — these are stubs, not real Solana mint addresses. Trading against real DFlow liquidity requires actual mints.
5. **Mock-data fallback is load-bearing.** `src/data/mockMarkets.js` is used whenever the DFlow fetch fails. Don't remove it without confirming the proxy works in every environment you ship to.
6. **No lint, no tests, no CI.** The export ships neither.

## Related ecosystem links

- [Eitherway overview (Genfinity, Feb 2026)](https://genfinity.io/2026/02/26/eitherway-ai-solana-web3-app-development-guide/)
- [Solana × Colosseum AI Agent Hackathon (Feb 2–12, 2026)](https://colosseum.com/agent-hackathon/)
- DFlow quote/order API used by this app: `https://dev-quote-api.dflow.net/quote` and `/order`
