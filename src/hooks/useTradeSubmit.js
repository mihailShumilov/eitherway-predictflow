import { useCallback, useState } from 'react'
import { useWallet } from './useWallet'
import { useConditionalOrders } from './useConditionalOrders'
import { useDCA } from './useDCA'
import { useKyc } from './useKyc'
import { useUserTier } from './useUserTier'
import { useReferral } from './useReferral'
import {
  DFLOW_QUOTE_URL, DFLOW_ORDER_URL, USDC_MINT,
  ALLOW_SYNTHESIZED_MINTS, ALLOW_SIMULATED_FILLS,
} from '../config/env'
import { fetchWithRetry, generateIdempotencyKey } from '../lib/http'
import { preflightTransaction } from '../lib/solanaPreflight'
import { decodeDflowTransaction, assertAllowedPrograms, validateTxPayload } from '../lib/txDecoder'
import { reportError } from '../lib/errorReporter'
import { track } from '../lib/analytics'
import { safeErrorMessage } from '../lib/errorMessage'
import { classifyOrderResponse, isGateRejection } from '../lib/dflowErrors'
import { formatSimulationError } from '../lib/simulationErrors'
import { appendPosition } from '../lib/storage'
import { calculateFee } from '../services/feeService'
import { recordReferralEarning } from '../services/referralService'
import { FEE_CONFIG, isFeeWalletConfigured } from '../config/fees'
import { buildFeeTransferTransaction } from '../lib/feeTransfer'
import { logFeeEvent } from '../lib/feeLog'
import { emitReferralUpdate } from './useReferral'

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

// Pull the platform (and optional referrer) fee out of the user's USDC ATA
// after the swap settled. Skipped when the fee wallet is the placeholder
// (no real recipient configured) — caller still records the event in the
// fee log so the revenue dashboard can show "would-be" fee accrual.
async function sweepFee({ address, activeWallet, feeCalc, referrer }) {
  if (!isFeeWalletConfigured()) {
    throw new Error('Fee wallet not configured — set VITE_FEE_WALLET to enable on-chain fee collection')
  }
  const provider = activeWallet?.getProvider?.()
  if (!provider) throw new Error('Wallet provider unavailable for fee transfer')

  const transfers = []
  if (feeCalc.platformAmount > 0) {
    transfers.push({
      toPubkey: FEE_CONFIG.FEE_WALLET,
      amountLamports: Math.floor(feeCalc.platformAmount * 1e6),
      label: 'platform',
    })
  }
  if (feeCalc.referralAmount > 0 && referrer) {
    transfers.push({
      toPubkey: referrer,
      amountLamports: Math.floor(feeCalc.referralAmount * 1e6),
      label: 'referrer',
    })
  }
  if (transfers.length === 0) return null

  const built = await buildFeeTransferTransaction({
    fromPubkey: address,
    mint: USDC_MINT,
    transfers,
  })
  if (!built) return null

  if (typeof provider.signAndSendTransaction === 'function') {
    return await provider.signAndSendTransaction(built.tx)
  }
  if (typeof provider.signTransaction === 'function') {
    return await provider.signTransaction(built.tx)
  }
  throw new Error('Wallet does not support signing')
}

// Encapsulates every trade-submission path (market / conditional / DCA) plus
// quote preview. Returns the UX state the panel wants to render and the set of
// handlers the panel wires to buttons.
export function useTradeSubmit(market) {
  const { connected, connect, address, activeWallet } = useWallet()
  const { addOrder } = useConditionalOrders()
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

    try {
      const outputMint = getTokenMint(market, side)
      if (!outputMint) throw new Error('Market has no tradeable outcome mint')
      const netLamports = Math.floor(netAmount * 1e6)
      const url = `${DFLOW_QUOTE_URL}?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${netLamports}`
      const res = await fetchWithRetry(url, {}, { retries: 1, timeoutMs: 6000 })
      if (res.ok) {
        const data = await res.json()
        setQuote({
          outputAmount: data.outAmount ? (data.outAmount / 1e6).toFixed(4) : shares,
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
      } else {
        throw new Error('Quote API unavailable')
      }
    } catch (err) {
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

      try {
        const url = `${DFLOW_ORDER_URL}?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${netLamports}&userPublicKey=${address}`
        const res = await fetchWithRetry(url, {
          headers: { 'X-Idempotency-Key': idempotencyKey },
        }, { retries: 1, timeoutMs: 8000 })
        if (!res.ok) {
          const classification = await classifyOrderResponse(res)
          const err = new Error(classification.message)
          err.status = classification.status
          err.kind = classification.kind
          throw err
        }
        const data = await res.json()

        const payloadCheck = validateTxPayload(data.transaction)
        if (!payloadCheck.ok) throw new Error(payloadCheck.error)

        const provider = activeWallet?.getProvider?.()
        if (!provider) throw new Error('No wallet provider — please reconnect')
        if (!data.transaction) throw new Error('Order API returned no transaction')

        // Decode + whitelist BEFORE signing — a compromised DFlow server can
        // otherwise swap in a drain-wallet instruction.
        const decoded = decodeDflowTransaction(data.transaction)
        if (!decoded.ok) throw new Error(decoded.error)
        const whitelist = assertAllowedPrograms(decoded.tx)
        if (!whitelist.ok) throw new Error(whitelist.error)

        const txBytes = typeof data.transaction === 'string'
          ? Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0))
          : data.transaction

        const pf = await preflightTransaction(txBytes)
        if (!pf.ok) {
          if (pf.unreachable) {
            throw new Error('Could not verify order with Solana RPC. Please try again.')
          }
          const formatted = formatSimulationError({
            error: pf.error,
            logs: pf.logs,
            summary: whitelist.summary,
          })
          const err = new Error(formatted.message)
          err.simDetails = formatted.details
          err.simLogs = formatted.logs
          err.simRaw = pf.error
          throw err
        }

        if (typeof provider.signAndSendTransaction === 'function') {
          const sent = await provider.signAndSendTransaction(decoded.tx)
          txSignature = sent?.signature || sent?.publicKey || null
          txSigned = !!txSignature
        } else if (typeof provider.signTransaction === 'function') {
          const signedTx = await provider.signTransaction(decoded.tx)
          const sig = signedTx?.signatures?.[0]
          const sigBytes = sig?.signature || (sig instanceof Uint8Array ? sig : null)
          txSignature = sigBytes
            ? Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')
            : 'signed'
          txSigned = true
        } else {
          throw new Error('Wallet does not support signing')
        }
      } catch (err) {
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
        try {
          await sweepFee({
            address,
            activeWallet,
            feeCalc,
            referrer,
          })
          feeStatus = 'sent'
        } catch (err) {
          feeStatus = 'failed'
          feeError = safeErrorMessage(err, 'Fee transfer failed')
          reportError(err, { context: 'feeTransfer', marketId: market.id })
        }
      }

      logFeeEvent({
        marketId: market.id,
        side,
        inputAmount: feeCalc.inputAmount,
        netAmount: feeCalc.netAmount,
        feeAmount: feeCalc.feeAmount,
        feeBps: feeCalc.feeBps,
        platformAmount: feeCalc.platformAmount,
        referralAmount: feeCalc.referralAmount,
        referrer: referrer || null,
        tier,
        feeStatus,
        txSigned,
      })
      if (feeCalc.referralAmount > 0 && referrer && feeStatus === 'sent') {
        recordReferralEarning(referrer, feeCalc.referralAmount)
        emitReferralUpdate()
      }

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
        question: market.question,
        eventTitle: market.eventTitle,
        category: market.category,
      })
      track('trade_filled', {
        marketId: market.id, side, amount: parseFloat(amount),
        simulated: !txSigned, feeStatus, feeAmount: feeCalc.feeAmount,
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

  const submitConditionalOrder = useCallback(({ orderType, side, amount, triggerPrice }) => {
    if (!connected) { connect(); return }
    if (!requireKyc()) return
    if (!amount || parseFloat(amount) <= 0) return
    if (!triggerPrice || parseFloat(triggerPrice) <= 0 || parseFloat(triggerPrice) >= 100) return

    const tp = parseFloat(triggerPrice) / 100
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
      side,
      amount: parseFloat(amount),
      triggerPrice: tp,
      currentPrice: price,
    })
    track('conditional_order_placed', {
      marketId: market.id, orderType, side, amount: parseFloat(amount), triggerPrice: tp,
    })
    setResult({ success: true, conditional: true, order: newOrder })
  }, [connected, connect, requireKyc, market, addOrder])

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
