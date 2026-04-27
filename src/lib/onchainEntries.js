// Reconstruct cost-basis (entry price + share count) for held outcome tokens
// from DFlow's on-chain trade history. Used as a fallback in usePortfolio
// when localStorage doesn't have a matching filled-order record — e.g. the
// user traded from another browser, or cleared site data.
//
// DFlow exposes /onchain-trades?wallet=<address> which returns parsed
// UserOrder fills with inputMint/outputMint and (scaled) amounts. Both USDC
// and outcome tokens use 6 decimals on Solana, so cost (USDC) divided by
// shares (outcome tokens) yields a per-share price in dollars without
// further conversion.
//
// Cost-basis method: weighted average across all BUY fills (USDC →
// outcomeMint). Partial sells reduce remaining shares but don't reset the
// basis — this matches how the rest of the app computes P&L and is
// standard for "what did you pay per share you still hold."

import { USDC_MINT } from '../config/env'
import { fetchWithRetry } from './http'
import { reportError } from './errorReporter'

// Decimals are the same for USDC and DFlow outcome mints (6), so a single
// divisor handles both. If DFlow ever ships outcome tokens with different
// decimals, this needs to switch to a per-mint lookup.
const TOKEN_SCALE = 1_000_000

function readNumeric(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function pickList(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  return payload.trades || payload.data || payload.items || payload.results || []
}

// Fetch on-chain UserOrder fills for a wallet and aggregate per-mint cost
// basis. Returns Map<outcomeMint, { avgPrice, shares }>. Empty map on
// error or empty response — callers should treat absence as "no entry data
// available" and not as a hard failure.
export async function buildOnchainEntries(walletAddress, dflowBase) {
  const out = new Map()
  if (!walletAddress || !dflowBase) return out

  try {
    const url = `${dflowBase}/api/v1/onchain-trades?wallet=${encodeURIComponent(walletAddress)}`
    const res = await fetchWithRetry(url)
    if (!res.ok) return out
    const payload = await res.json()
    const trades = pickList(payload)
    if (!Array.isArray(trades) || trades.length === 0) return out

    // Per-mint accumulators: `bought` tracks shares we've bought (used for
    // cost-basis); `sold` tracks shares we've sold (used to derive
    // remaining shares). Cost basis is computed against `bought` only —
    // sells don't shift the average price of what we still hold.
    const acc = new Map()

    for (const t of trades) {
      if (!t || typeof t !== 'object') continue

      // Skip non-fill events. `/onchain-trades` should be pre-filtered to
      // fills, but defensively reject anything tagged otherwise.
      const eventType = (t.eventType ?? t.type ?? t.event ?? 'fill').toString().toLowerCase()
      if (eventType && !['fill', 'filled', 'userorder', 'user_order', 'trade'].includes(eventType)) {
        continue
      }

      const inMint = t.inputMint ?? t.input_mint ?? t.fromMint ?? t.from_mint
      const outMint = t.outputMint ?? t.output_mint ?? t.toMint ?? t.to_mint
      const inRaw = readNumeric(t.inputAmount ?? t.input_amount ?? t.fromAmount)
      const outRaw = readNumeric(t.outputAmount ?? t.output_amount ?? t.toAmount)
      if (!inMint || !outMint || inRaw == null || outRaw == null) continue

      const inAmount = inRaw / TOKEN_SCALE
      const outAmount = outRaw / TOKEN_SCALE
      if (inAmount <= 0 || outAmount <= 0) continue

      // BUY: USDC → outcomeMint. Add to bought + cost.
      if (inMint === USDC_MINT && outMint !== USDC_MINT) {
        const slot = acc.get(outMint) || { bought: 0, cost: 0, sold: 0 }
        slot.bought += outAmount
        slot.cost += inAmount
        acc.set(outMint, slot)
        continue
      }

      // SELL: outcomeMint → USDC. Add to sold (reduces remaining shares but
      // does not change avg cost basis on what's left).
      if (outMint === USDC_MINT && inMint !== USDC_MINT) {
        const slot = acc.get(inMint) || { bought: 0, cost: 0, sold: 0 }
        slot.sold += inAmount
        acc.set(inMint, slot)
        continue
      }

      // Other routes (outcomeMint → outcomeMint, USDC → USDC) are not
      // produced by the standard open/close flow — ignore them.
    }

    for (const [mint, { bought, cost, sold }] of acc.entries()) {
      if (bought <= 0) continue
      const remaining = bought - sold
      out.set(mint, {
        avgPrice: cost / bought,
        shares: remaining > 0 ? remaining : 0,
      })
    }

    return out
  } catch (err) {
    reportError(err, { context: 'buildOnchainEntries' })
    return out
  }
}
