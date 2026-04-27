// Bookkeeping for a successful market-trade fill.
//
// Extracted from useTradeSubmit so the hook can stay focused on
// orchestration (validate → pipeline → fee sweep → result state). Called
// after the swap settles, regardless of whether the fee sweep succeeded.
//
// Side effects:
//   - appendPosition: writes the fill into the local positions ledger
//     (Portfolio + Positions read this).
//   - logFeeEvent: appends to the fee log so the admin revenue dashboard
//     and the user-facing fee disclosure stay in sync.
//   - track('trade_filled'): analytics ping (PostHog / Plausible / etc.).
//   - emitLocalTrade: pushes an optimistic row to RecentTrades so the
//     user sees their fill on the tape before DFlow's indexer catches up.
//   - recordReferralEarning + emitReferralUpdate: when a referrer is
//     attached and the fee sweep landed, credit them.
//
// All side effects are best-effort — a failure in any of them must not
// surface to the caller as a trade failure (the trade has already
// settled on-chain).

import { appendPosition } from './storage'
import { logFeeEvent } from './feeLog'
import { maskWallet } from './privacy'
import { track } from './analytics'
import { emitLocalTrade } from './tradeEvents'
import { recordReferralEarning } from '../services/referralService'
import { emitReferralUpdate } from '../hooks/useReferral'

export function recordTradeOutcome({
  market,
  side,
  amount,             // user-entered USDC
  shares,
  price,              // 0..1 — fill price
  txSigned,
  txSignature,
  idempotencyKey,
  feeCalc,
  feeStatus,
  feeError,
  tier,
  referrer,
}) {
  // Build the order record once. Used by appendPosition + result state.
  const order = {
    id: idempotencyKey,
    marketId: market.id,
    side,
    type: 'market',
    amount: parseFloat(amount),
    netAmount: feeCalc.netAmount,
    feeAmount: feeCalc.feeAmount,
    price,
    shares: parseFloat(shares),
    timestamp: new Date().toISOString(),
    status: 'filled',
    txSigned,
    txSignature: txSignature || (txSigned ? 'signed' : 'simulated'),
    feeStatus,
    feeError,
  }

  appendPosition({
    ...order,
    // Stable on-chain identifiers — the synthesized `marketId` may
    // not survive across page loads, so persist the Kalshi ticker and
    // outcome mints. usePortfolio uses these to resolve win/loss for
    // settled positions even when they're rendered via the local
    // fallback (no on-chain wallet match).
    ticker: market.ticker || null,
    eventTicker: market.eventTicker || null,
    seriesTicker: market.seriesTicker || null,
    yesMint: market.yesMint || null,
    noMint: market.noMint || null,
    // Subtitle disambiguates scalar markets (e.g. score thresholds) that
    // share an identical question text across an event.
    subtitle: market.subtitle || null,
    yesSubTitle: market.yesSubTitle || null,
    noSubTitle: market.noSubTitle || null,
    question: market.question,
    eventTitle: market.eventTitle,
    category: market.category,
    closeTime: market.closeTime || null,
  })

  logFeeEvent({
    marketId: market.id,
    side,
    inputAmount: feeCalc.inputAmount,
    netAmount: feeCalc.netAmount,
    feeAmount: feeCalc.feeAmount,
    feeBps: feeCalc.feeBps,
    platformAmount: feeCalc.platformAmount,
    referralAmount: feeCalc.referralAmount,
    referrer: referrer ? maskWallet(referrer) : null,
    tier,
    feeStatus,
    txSigned,
  })

  if (feeCalc.referralAmount > 0 && referrer && feeStatus === 'sent') {
    recordReferralEarning(referrer, feeCalc.referralAmount)
    emitReferralUpdate()
  }

  track('trade_filled', {
    marketId: market.id,
    side,
    amount: parseFloat(amount),
    simulated: !txSigned,
    feeStatus,
    feeAmount: feeCalc.feeAmount,
  })

  // Optimistically broadcast to RecentTrades — DFlow's /trades feed lags
  // by several seconds and the user expects to see their own fill on the
  // tape immediately. RecentTrades dedupes by txSignature once the
  // indexed version arrives.
  emitLocalTrade({
    id: `local-${txSignature || idempotencyKey}`,
    marketId: market.id,
    ticker: market.ticker || market.id,
    time: order.timestamp,
    side: side === 'no' ? 'sell' : 'buy',
    price,
    shares: parseFloat(shares),
    amount: parseFloat(amount),
    txSignature,
  })

  return order
}
