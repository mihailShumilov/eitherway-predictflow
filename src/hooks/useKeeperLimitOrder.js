// Place a conditional order through the keeper — limit, stop-loss, or
// take-profit.
//
// Direction mapping:
//   - limit BUY:  inputMint = USDC,         outputMint = outcomeMint (yes/no)
//                 user spends USDC to acquire shares
//   - stop-loss / take-profit (SELL):
//                 inputMint = outcomeMint,  outputMint = USDC
//                 user sells existing position back to USDC
//
// End-to-end flow:
//   1. Ensure session — sign in with Solana if no token yet.
//   2. Ensure durable nonce account for (wallet, marketTicker) exists.
//      First time per market this prompts the wallet to fund a fresh
//      nonce account (~0.0015 SOL rent).
//   3. For SELL orders: read the user's outcome-token balance and
//      validate they hold ≥ the share count we're about to sign for.
//   4. Fetch DFlow /order with a normal blockhash and the appropriate
//      mint direction.
//   5. Compose with the durable nonce — recentBlockhash becomes the
//      nonce value; first instruction becomes advanceNonceAccount.
//   6. Wallet signs the recomposed transaction.
//   7. POST /orders to the keeper with the signed tx + nonce metadata
//      + trigger metadata.
//
// All steps are idempotent enough that a partial failure (e.g. user
// cancels the wallet popup at step 6) leaves no on-chain side effects
// past step 2 — the nonce account is reusable for the next attempt.

import { useCallback } from 'react'
import { useWallet } from './useWallet'
import { useKyc } from './useKyc'
import { USDC_MINT, SOLANA_RPC_ENDPOINTS, SOLANA_RPC_URL } from '../config/env'
import { runOrderPipeline } from '../lib/orderTxPipeline'
import { signIn } from '../lib/walletAuth'
import { getSession, getDurableNonce, registerDurableNonce, placeOrder, listOrders, isKeeperConfigured } from '../lib/keeperApi'
import {
  createDurableNonce,
  composeOrderWithNonce,
  getNonce,
} from '../lib/durableNonce'
import { getOutcomeBalance } from '../lib/outcomeBalance'

function rpcUrl() {
  return SOLANA_RPC_URL || (SOLANA_RPC_ENDPOINTS && SOLANA_RPC_ENDPOINTS[0]) || 'https://api.mainnet-beta.solana.com'
}

async function ensureSession(activeWallet, address) {
  const existing = getSession()
  if (existing) return existing
  return await signIn(activeWallet, address)
}

async function ensureNonce({ activeWallet, address, marketTicker }) {
  // Look up the user's existing nonce for this market. If found, just
  // refresh its current value (it may have advanced since registration).
  const url = rpcUrl()
  let existing = null
  try {
    existing = await getDurableNonce({ marketTicker })
  } catch (err) {
    if (err.status !== 404) throw err
  }
  if (existing?.pubkey) {
    const live = await getNonce(url, existing.pubkey)
    if (live) {
      return { pubkey: existing.pubkey, currentNonce: live }
    }
    // Nonce account vanished (closed by user out-of-band). Fall through
    // and create a new one — overrides the stale registration.
  }

  // Create + fund + register a fresh nonce account.
  const provider = activeWallet?.getProvider?.()
  if (!provider) throw new Error('Wallet provider unavailable for nonce account creation')

  const signAndSend = async (tx) => {
    if (typeof provider.signAndSendTransaction === 'function') {
      const sent = await provider.signAndSendTransaction(tx)
      return sent?.signature || sent?.publicKey || null
    }
    if (typeof provider.signTransaction === 'function') {
      // Two-step path for older adapters. Signed bytes need to be sent
      // via raw RPC. We use the same Connection the helper caches.
      const signed = await provider.signTransaction(tx)
      const { Connection } = await import('@solana/web3.js')
      const conn = new Connection(url, 'confirmed')
      return await conn.sendRawTransaction(signed.serialize())
    }
    throw new Error('Wallet does not support signing')
  }

  const created = await createDurableNonce({
    rpcUrl: url,
    authorityPubkey: address,
    signAndSend,
  })

  await registerDurableNonce({
    pubkey: created.pubkey,
    marketTicker,
    currentNonce: created.currentNonce,
  })

  return { pubkey: created.pubkey, currentNonce: created.currentNonce }
}

export function useKeeperLimitOrder() {
  const { connected, connect, address, activeWallet } = useWallet()
  const { requireKyc, verifyWithServer } = useKyc()

  const placeLimit = useCallback(async ({
    market,
    side,             // 'yes' | 'no'
    orderType,        // 'limit' | 'stop-loss' | 'take-profit'
    triggerPrice,     // 0..1
    amountUsdc,       // USDC value of the trade at trigger price
  }) => {
    if (!connected) { connect(); throw new Error('Connect wallet first') }
    if (!requireKyc()) throw new Error('Verify identity first')
    const serverOk = await verifyWithServer()
    if (!serverOk) throw new Error('KYC verification failed')

    if (!isKeeperConfigured()) {
      throw new Error('Keeper backend not configured (VITE_KEEPER_API_BASE)')
    }
    if (!market?.ticker) throw new Error('Market ticker required')
    if (!market?.yesMint || !market?.noMint) {
      throw new Error('Market lacks tradeable outcome mints')
    }
    const isSell = orderType === 'stop-loss' || orderType === 'take-profit'
    const outcomeMint = side === 'yes' ? market.yesMint : market.noMint

    // 1. Session
    await ensureSession(activeWallet, address)

    // 1b. Refuse if a non-terminal keeper order already exists for this market.
    //     The server enforces the same rule (409 duplicate_pending_order), so
    //     this client check is purely UX — fail before the wallet popup
    //     instead of after. Race-safe because the server has the final say.
    try {
      const existing = await listOrders({ market: market.ticker })
      const live = (existing?.orders ?? []).find((o) =>
        o.status === 'pending' || o.status === 'armed' || o.status === 'submitting'
      )
      if (live) {
        throw new Error(
          'You already have an active limit order for this market. Cancel it before placing another.',
        )
      }
    } catch (err) {
      // Re-throw the duplicate guard, but tolerate listOrders failures —
      // the server will catch the duplicate at POST time and return 409.
      if (err?.message?.startsWith('You already have')) throw err
    }

    // 2. Nonce account
    const nonce = await ensureNonce({
      activeWallet,
      address,
      marketTicker: market.ticker,
    })

    // 3. SELL-only: validate position size + compute share count.
    //    BUY (limit) skips this and asks DFlow for an exact-USDC-in swap.
    let inputMint, outputMint, dflowAmount
    if (isSell) {
      // Convert the user's USDC-denominated input into shares to sell at
      // the trigger price. amount=$10, trigger=0.40 → sell 25 shares.
      // We request DFlow with an exact-input-amount of shares (in their
      // 6-decimal scaled units — outcome tokens use the same precision
      // as USDC by DFlow convention).
      const sharesToSell = amountUsdc / triggerPrice
      const balance = await getOutcomeBalance({
        rpcUrl: rpcUrl(),
        owner: address,
        mint: outcomeMint,
      })
      if (balance + 1e-6 < sharesToSell) {
        throw new Error(
          `Insufficient ${side.toUpperCase()} shares — you hold ${balance.toFixed(2)}, this order needs ${sharesToSell.toFixed(2)}.`,
        )
      }
      inputMint = outcomeMint
      outputMint = USDC_MINT
      dflowAmount = Math.floor(sharesToSell * 1e6)
    } else {
      // BUY (limit) — exact USDC in.
      inputMint = USDC_MINT
      outputMint = outcomeMint
      dflowAmount = Math.floor(amountUsdc * 1e6)
    }

    // 4. DFlow /order — sign-only mode. The shared pipeline does the
    //    fetch + decode + whitelist; we'll compose with the durable
    //    nonce, then have the wallet sign the recomposed tx ourselves
    //    rather than asking the pipeline to broadcast (the keeper does
    //    that later when the trigger crosses).
    const provider = activeWallet?.getProvider?.()
    const result = await runOrderPipeline({
      inputMint,
      outputMint,
      amountLamports: dflowAmount,
      userPublicKey: address,
      idempotencyPrefix: orderType.slice(0, 4),
      provider,
      // Skip preflight — the durable nonce isn't valid until composition,
      // so simulating the original tx wouldn't catch the keeper's actual
      // submission failure modes. The keeper validates at submit time.
      preflight: false,
      broadcast: 'sign-only',
      // Wide slippage tolerance: a keeper-held tx may sit signed for hours
      // before the trigger fires. The orderbook can move materially in
      // that window, and DFlow's default tight slippage causes the swap
      // to revert at submission time (FillUnderproduced / FillOverconsumed
      // / generic init-escrow rejections). The user's price commitment is
      // captured by the trigger condition, so we let the actual fill
      // execute against whatever the book looks like at fire time.
      slippageBps: 'auto',
      priceImpactTolerancePct: 10,
    })
    if (!result.ok) throw new Error(result.error)

    // 5. Compose with the durable nonce — recentBlockhash becomes the
    //    nonce value; `advanceNonceAccount` becomes instruction 0.
    const recomposed = await composeOrderWithNonce({
      rpcUrl: rpcUrl(),
      originalTx: result.decodedTx,
      noncePubkey: nonce.pubkey,
      nonceAuthority: address,
      currentNonce: nonce.currentNonce,
    })

    // 6. Wallet signs the recomposed tx (off-chain — no broadcast yet).
    if (!provider) throw new Error('Wallet provider unavailable')
    if (typeof provider.signTransaction !== 'function') {
      throw new Error('Wallet does not support signTransaction (off-chain) — required for limit orders')
    }
    const signedTx = await provider.signTransaction(recomposed)
    const signedBytes = signedTx.serialize()

    // 6. Submit to keeper. Encode chunked — `String.fromCharCode(...bytes)`
    // spreads a Uint8Array as function args and trips the JS call-stack
    // arg limit on V8 for txs near the 1232-byte Solana packet ceiling.
    let bin = ''
    for (let i = 0; i < signedBytes.length; i++) bin += String.fromCharCode(signedBytes[i])
    const signedTxBase64 = btoa(bin)
    const order = await placeOrder({
      marketTicker: market.ticker,
      marketId: market.id,
      eventTicker: market.eventTicker,
      side,
      orderType,
      triggerPrice,
      amountUsdc,
      yesMint: market.yesMint,
      noMint: market.noMint,
      signedTxBase64,
      durableNoncePubkey: nonce.pubkey,
      durableNonceValue: nonce.currentNonce,
    })

    return order
  }, [connected, connect, address, activeWallet, requireKyc, verifyWithServer])

  return { placeLimit }
}
