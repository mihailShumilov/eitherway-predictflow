import { useCallback, useState } from 'react'
import { useWallet } from './useWallet'
import { useConditionalOrders } from './useConditionalOrders'
import { useDCA } from './useDCA'
import { useKyc } from './useKyc'
import { useUserTier } from './useUserTier'
import { useReferral } from './useReferral'
import {
  DFLOW_QUOTE_URL, USDC_MINT,
  ALLOW_SYNTHESIZED_MINTS, ALLOW_SIMULATED_FILLS,
} from '../config/env'
import { fetchWithRetry, generateIdempotencyKey } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { track } from '../lib/analytics'
import { safeErrorMessage } from '../lib/errorMessage'
import { isGateRejection } from '../lib/dflowErrors'
import { runOrderPipeline } from '../lib/orderTxPipeline'
import { isKeeperConfigured } from '../lib/keeperApi'
import { useKeeperApprovalOrder } from './useKeeperApprovalOrder'
import { calculateFee } from '../services/feeService'
import {
  sweepFee, isSweepInCooldown, recordSweepFailure, recordSweepSuccess,
} from '../lib/feeSweep'
import { recordTradeOutcome } from '../lib/recordTradeOutcome'

function getRealMint(market, side) {
  if (side === 'yes' && market.yesMint) return market.yesMint
  if (side === 'no' && market.noMint) return market.noMint
  return null
}

function getTokenMint(market, side) {
  const real = getRealMint(market, side)
  if (real) return real
  if (ALLOW_SYNTHESIZED_MINTS) {
    return side === 'yes' ? `YES-${market.id}-mint` : `NO-${market.id}-mint`
  }
  return null
}

// Module-level inflight lock — survives a component remount so closing and
// reopening the trade panel while a submit is still pending cannot double-spend.
const submissionLocks = new Set()

// Encapsulates every trade-submission path (market / conditional / DCA) plus
// quote preview. Returns the UX state the panel wants to render and the set of
// handlers the panel wires to buttons.
export function useTradeSubmit(market) {
  const { connected, connect, address, activeWallet } = useWallet()
  const { addOrder } = useConditionalOrders()
  const { placeLimit: placeApprovalLimit } = useKeeperApprovalOrder()
  const { startStrategy } = useDCA()
  const { requireKyc, verifyWithServer, showModalWithReason } = useKyc()
  const { tier } = useUserTier()
  const { referrer, hasReferrer } = useReferral()

  const [submitting, setSubmitting] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [quote, setQuote] = useState(null)
  const [result, setResult] = useState(null)

  const resetQuote = useCallback(() => setQuote(null), [])
  const resetResult = useCallback(() => setResult(null), [])

  const previewQuote = useCallback(async ({ side, amount }) => {
    if (!amount || parseFloat(amount) <= 0) return
    setPreviewing(true)
    setQuote(null)
    const price = side === 'yes' ? market.yesAsk : market.noAsk
    const inputAmount = parseFloat(amount)
    // Fee is deducted *before* DFlow sees the order, so the est. shares
    // shown to the user reflect the post-fee net amount.
    const feeCalc = calculateFee(inputAmount, tier, hasReferrer)
    const netAmount = feeCalc.netAmount
    const shares = (netAmount / price).toFixed(2)

    track('trade_quote_requested', {
      market_id: market.id, market_ticker: market.ticker, side, amount: inputAmount, tier,
    })

    try {
      const outputMint = getTokenMint(market, side)
      if (!outputMint) throw new Error('Market has no tradeable outcome mint')
      const netLamports = Math.floor(netAmount * 1e6)
      const url = `${DFLOW_QUOTE_URL}?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${netLamports}`
      const res = await fetchWithRetry(url, {}, { retries: 1, timeoutMs: 6000 })
      if (res.ok) {
        const data = await res.json()
        const out = data.outAmount ? (data.outAmount / 1e6).toFixed(4) : shares
        setQuote({
          outputAmount: out,
          priceImpact: data.priceImpact || '0.12',
          fee: feeCalc.feeAmount.toFixed(4),
          feeBps: feeCalc.feeBps,
          netAmount: feeCalc.netAmount,
          inputAmount: feeCalc.inputAmount,
          referralAmount: feeCalc.referralAmount,
          platformAmount: feeCalc.platformAmount,
          tier,
          route: data.routePlan?.length || 1,
          source: 'DFlow',
        })
        track('trade_quote_received', {
          market_id: market.id, side, amount: inputAmount, output_amount: parseFloat(out),
          fee: feeCalc.feeAmount, source: 'DFlow', route: data.routePlan?.length || 1,
        })
      } else {
        throw new Error('Quote API unavailable')
      }
    } catch (err) {
      track('trade_quote_failed', {
        market_id: market.id, side, reason: err?.message || 'unknown',
      })
      if (!ALLOW_SIMULATED_FILLS) {
        setQuote({ error: err.message || 'Unable to fetch quote. Try again.' })
        return
      }
      const slippage = Math.random() * 0.5 + 0.05
      setQuote({
        outputAmount: shares,
        priceImpact: slippage.toFixed(2),
        fee: feeCalc.feeAmount.toFixed(4),
        feeBps: feeCalc.feeBps,
        netAmount: feeCalc.netAmount,
        inputAmount: feeCalc.inputAmount,
        referralAmount: feeCalc.referralAmount,
        platformAmount: feeCalc.platformAmount,
        tier,
        route: 1,
        source: 'Simulated',
      })
    } finally {
      setPreviewing(false)
    }
  }, [market, tier, hasReferrer])

  const submitMarketTrade = useCallback(async ({ side, amount }) => {
    if (!connected) { connect(); return }
    if (!requireKyc()) return
    const serverOk = await verifyWithServer()
    if (!serverOk) return
    if (!amount || parseFloat(amount) <= 0) return

    const nonce = `${market.id}:${side}:${amount}`
    if (submissionLocks.has(nonce)) return
    submissionLocks.add(nonce)

    setSubmitting(true)
    setResult(null)

    const price = side === 'yes' ? market.yesAsk : market.noAsk

    let firstError = null
    const fail = (err) => { if (!firstError) firstError = err }

    try {
      const outputMint = getTokenMint(market, side)
      if (!outputMint) {
        throw new Error('This market has no tradeable outcome mint yet. Try another market.')
      }
      const inputAmountUSDC = parseFloat(amount)
      const feeCalc = calculateFee(inputAmountUSDC, tier, !!referrer)
      // Shares = net (post-fee) USDC / price — what DFlow actually buys.
      const shares = (feeCalc.netAmount / price).toFixed(2)
      // DFlow sees only the post-fee amount; the difference stays in the user's
      // USDC ATA and gets swept by a follow-up transfer below.
      const netLamports = Math.floor(feeCalc.netAmount * 1e6)
      const idempotencyKey = generateIdempotencyKey('mkt')
      track('trade_submit', {
        marketId: market.id, side, amount: inputAmountUSDC, orderType: 'market',
        tier, feeBps: feeCalc.feeBps, hasReferrer: !!referrer,
      })

      let txSigned = false
      let txSignature = null

      const provider = activeWallet?.getProvider?.()
      const result = await runOrderPipeline({
        inputMint: USDC_MINT,
        outputMint,
        amountLamports: netLamports,
        userPublicKey: address,
        idempotencyPrefix: 'mkt',
        provider,
        preflight: true,
        broadcast: 'send',
      })
      if (result.ok) {
        txSigned = true
        txSignature = result.signature
      } else {
        const err = new Error(result.error)
        if (result.kind) err.kind = result.kind        // KYC / compliance routing
        if (result.status) err.status = result.status
        if (result.simDetails) err.simDetails = result.simDetails
        if (result.simLogs) err.simLogs = result.simLogs
        if (result.simRaw) err.simRaw = result.simRaw
        fail(err)
      }

      if (!txSigned && !ALLOW_SIMULATED_FILLS) {
        throw firstError || new Error('Order could not be signed. No trade was placed.')
      }

      // Best-effort fee sweep: a separate signed tx pulls platform fee
      // (and optional referral split) from the user's USDC ATA. If this
      // step fails, the swap already settled, so we record the intent in
      // the fee log and let the user know — we never roll the trade back.
      let feeStatus = 'skipped'
      let feeError = null
      if (txSigned && feeCalc.feeAmount > 0) {
        if (isSweepInCooldown()) {
          // Repeated failures suggest a misconfigured fee wallet or a user
          // who keeps rejecting the second prompt. Skip sweeping until the
          // cooldown elapses so we don't pop the wallet on every trade.
          feeStatus = 'rate-limited'
          feeError = 'Fee transfer skipped — too many consecutive failures, retrying later'
          track('fee_sweep_rate_limited', { market_id: market.id })
        } else {
          try {
            await sweepFee({
              address,
              activeWallet,
              feeCalc,
              referrer,
            })
            feeStatus = 'sent'
            recordSweepSuccess()
            track('fee_sweep_sent', {
              market_id: market.id, fee_amount: feeCalc.feeAmount,
              referral_amount: feeCalc.referralAmount, platform_amount: feeCalc.platformAmount,
            })
          } catch (err) {
            feeStatus = 'failed'
            feeError = safeErrorMessage(err, 'Fee transfer failed')
            recordSweepFailure()
            reportError(err, { context: 'feeTransfer', marketId: market.id })
            track('fee_sweep_failed', {
              market_id: market.id, reason: feeError, fee_amount: feeCalc.feeAmount,
            })
          }
        }
      }

      const order = recordTradeOutcome({
        market, side, amount, shares, price,
        txSigned, txSignature, idempotencyKey,
        feeCalc, feeStatus, feeError,
        tier, referrer,
      })
      track('trade_succeeded', {
        market_id: market.id, market_ticker: market.ticker,
        side, amount: inputAmountUSDC, shares: parseFloat(shares), price,
        tx_signed: txSigned, tx_signature: txSignature,
        fee_status: feeStatus, fee_amount: feeCalc.feeAmount, tier,
      })
      setResult({ success: true, order, feeCalc, feeStatus, feeError })
      setQuote(null)
    } catch (err) {
      reportError(err, { context: 'handleMarketTrade', marketId: market.id })
      track('trade_failed', { marketId: market.id, side, reason: err.message, kind: err.kind || 'other' })
      const message = safeErrorMessage(err, 'Order failed')
      // DFlow is the regulated party — when /order rejects for KYC/compliance
      // reasons we surface the upstream message in the KYC modal so the user
      // knows exactly what to go fix.
      if (isGateRejection({ kind: err.kind })) {
        showModalWithReason(message)
      }
      setResult({
        success: false,
        error: message,
        details: err.simDetails || null,
        logs: err.simLogs || null,
        raw: err.simRaw || null,
      })
    } finally {
      submissionLocks.delete(nonce)
      setSubmitting(false)
    }
  }, [connected, connect, requireKyc, verifyWithServer, showModalWithReason, market, address, activeWallet, tier, referrer])

  const submitConditionalOrder = useCallback(async ({ orderType, side, amount, triggerPrice }) => {
    if (!connected) { connect(); return }
    if (!requireKyc()) return
    if (!amount || parseFloat(amount) <= 0) {
      setResult({ success: false, error: 'Enter a valid USDC amount' })
      return
    }
    const triggerNum = parseFloat(triggerPrice)
    if (!triggerPrice || !Number.isFinite(triggerNum) || triggerNum <= 0 || triggerNum >= 100) {
      setResult({ success: false, error: 'Enter a trigger price between 0.1¢ and 99¢' })
      return
    }

    const tp = triggerNum / 100
    const price = side === 'yes' ? market.yesAsk : market.noAsk
    if (orderType === 'stop-loss' && tp >= price) {
      setResult({ success: false, error: 'Stop-loss trigger must be below current price' })
      return
    }
    if (orderType === 'take-profit' && tp <= price) {
      setResult({ success: false, error: 'Take-profit target must be above current price' })
      return
    }
    const hasRealMints = !!(market.yesMint && market.noMint)
    if (!hasRealMints && !ALLOW_SYNTHESIZED_MINTS) {
      setResult({ success: false, error: 'This market has no tradeable outcome mint yet.' })
      return
    }

    // All conditional order types go through the approval flow when the
    // keeper is configured. The approval flow is wallet-agnostic (works
    // with Phantom + Solflare + Backpack — none of them inject anything
    // into a plain spl-token approve tx that would matter), so we no
    // longer need the legacy durable-nonce path for any new orders. The
    // legacy path stays in place server-side to drain in-flight rows.
    //
    // Direction matrix is handled inside placeApprovalLimit:
    //   limit (BUY):       USDC → outcome
    //   stop-loss (SELL):  outcome → USDC
    //   take-profit (SELL):outcome → USDC
    if (
      (orderType === 'limit' || orderType === 'stop-loss' || orderType === 'take-profit') &&
      isKeeperConfigured()
    ) {
      setSubmitting(true)
      try {
        const result = await placeApprovalLimit({
          market, side, orderType,
          triggerPrice: tp,
          amountUsdc: parseFloat(amount),
        })
        track('conditional_order_placed', {
          marketId: market.id, orderType, side, amount: parseFloat(amount),
          triggerPrice: tp, backend: 'keeper-approval',
        })
        setResult({ success: true, conditional: true, order: { ...result, orderType, triggerPrice: tp, amount: parseFloat(amount) } })
      } catch (err) {
        reportError(err, { context: 'submitConditionalOrder/approval', marketId: market.id })
        setResult({ success: false, error: safeErrorMessage(err, 'Keeper placement failed') })
      } finally {
        setSubmitting(false)
      }
      return
    }

    const newOrder = addOrder({
      orderType,
      marketId: market.id,
      marketTicker: market.ticker,
      eventTicker: market.eventTicker,
      yesMint: market.yesMint,
      noMint: market.noMint,
      question: market.question,
      eventTitle: market.eventTitle,
      category: market.category,
      closeTime: market.closeTime || null,
      side,
      amount: parseFloat(amount),
      triggerPrice: tp,
      currentPrice: price,
    })
    track('conditional_order_placed', {
      marketId: market.id, orderType, side, amount: parseFloat(amount), triggerPrice: tp,
    })
    setResult({ success: true, conditional: true, order: newOrder })
  }, [connected, connect, requireKyc, market, addOrder, placeApprovalLimit])

  const submitDca = useCallback(({ side, amountPerBuy, frequency, totalBudget }) => {
    if (!connected) { connect(); return }
    if (!requireKyc()) return
    const hasRealMints = !!(market.yesMint && market.noMint)
    if (!hasRealMints && !ALLOW_SYNTHESIZED_MINTS) {
      setResult({ success: false, error: 'This market has no tradeable outcome mint yet.' })
      return
    }
    const perBuy = parseFloat(amountPerBuy) || 0
    const budget = parseFloat(totalBudget) || 0
    const purchases = perBuy > 0 ? Math.floor(budget / perBuy) : 0
    if (perBuy <= 0 || budget <= 0 || purchases <= 0) {
      setResult({ success: false, error: 'Enter valid amount and budget' })
      return
    }
    const price = side === 'yes' ? market.yesAsk : market.noAsk
    const strategy = startStrategy({
      marketId: market.id,
      marketTicker: market.ticker,
      eventTicker: market.eventTicker,
      yesMint: market.yesMint,
      noMint: market.noMint,
      question: market.question,
      eventTitle: market.eventTitle,
      category: market.category,
      closeTime: market.closeTime || null,
      side,
      amountPerBuy: perBuy,
      frequency,
      totalBudget: budget,
      referencePrice: price,
    })
    track('dca_started', {
      marketId: market.id, side, amountPerBuy: perBuy, budget, frequency,
    })
    setResult({ success: true, dca: true, strategy })
  }, [connected, connect, requireKyc, market, startStrategy])

  return {
    submitting,
    previewing,
    quote,
    result,
    resetQuote,
    resetResult,
    previewQuote,
    submitMarketTrade,
    submitConditionalOrder,
    submitDca,
  }
}
