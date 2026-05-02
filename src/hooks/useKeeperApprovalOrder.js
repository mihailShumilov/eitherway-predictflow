// Approval-flow keeper conditional order — covers limit, stop-loss, and
// take-profit. Replaces the durable-nonce flow for wallets that inject
// Lighthouse-style assertions (Phantom and most "smart" wallets) — the
// user's only on-chain action is an spl-token `approve`, which doesn't
// care about instruction position-0 invariants. The keeper holds the
// executor key and signs the actual swap at fire time.
//
// Direction matrix:
//   limit (BUY):       inputMint = USDC, outputMint = outcome
//   stop-loss (SELL):  inputMint = outcome, outputMint = USDC
//   take-profit (SELL):inputMint = outcome, outputMint = USDC
//
// The user approves spending on the inputMint ATA. spl-token has one
// delegate per token account; we compute the cumulative delegated amount
// across all of THIS user's active orders that share the same inputMint
// (i.e. orders draining the same ATA), and re-approve the new total each
// time. Approvals on different mints (USDC vs outcome) are independent
// delegations and don't overwrite each other.
//
// Custody:
//   - User delegates up to N atomic units of `inputMint` from their ATA to
//     the keeper-controlled executor pubkey.
//   - At fire time the keeper builds tx [advanceNonce, transferChecked,
//     DFlow swap], signs as executor, broadcasts.
//   - For BUYS, outcome tokens land directly in the user's wallet via
//     DFlow's `destinationWallet` parameter. For SELLS, USDC lands the
//     same way.
//   - User can `revoke` their ATA(s) at any time to wipe delegation.
//   - Compromise of the executor key is bounded per-user by their delegated
//     amount; orders cannot fire above the delegated value.

import { useCallback } from 'react'
import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import {
  createApproveCheckedInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

import { useWallet } from './useWallet'
import { useKyc } from './useKyc'
import {
  USDC_MINT, SOLANA_RPC_ENDPOINTS, SOLANA_RPC_URL,
} from '../config/env'
import { signIn } from '../lib/walletAuth'
import { waitForConfirmation } from '../lib/durableNonce'
import {
  getSession, listOrders, placeOrder, getConfig, isKeeperConfigured,
  cancelOrdersByMint,
} from '../lib/keeperApi'

const USDC_DECIMALS = 6  // DFlow markets settle in USDC (6 decimals).
const OUTCOME_DECIMALS = 6  // DFlow outcome tokens use the same 6-decimal scale.

function rpcUrl() {
  return SOLANA_RPC_URL || (SOLANA_RPC_ENDPOINTS && SOLANA_RPC_ENDPOINTS[0]) || 'https://api.mainnet-beta.solana.com'
}

async function ensureSession(activeWallet, address) {
  const existing = getSession()
  if (existing) return existing
  return await signIn(activeWallet, address)
}

// Build → sign → send → confirm with one retry on blockhash expiry. The
// approve / revoke txs use a regular recentBlockhash (not durable nonce)
// because the user's wallet may inject Lighthouse-style instructions that
// break advanceNonceAccount's position-0 invariant. A regular blockhash
// ages out after ~150 slots (~60s), so a slow wallet popup leads to the
// network rejecting the tx with "block height exceeded". On that error
// only, refetch a fresh blockhash and ask the user to re-sign once.
//
// Confirmation is poll-based via waitForConfirmation: web3.js's built-in
// confirmTransaction tries to open a pubsub WebSocket on a derived
// `ws://host:port+1` URL, which is blocked by CSP behind our same-origin
// /api/rpc proxy.
async function signSendConfirm({ provider, conn, buildTx, maxAttempts = 2 }) {
  let lastErr
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Pair blockhash + lastValidBlockHeight on the way in: web3.js's
    // Transaction constructor only sets `recentBlockhash` when given the
    // pair (or the deprecated `recentBlockhash` field). With just
    // `blockhash`, it silently leaves the tx without a blockhash and the
    // wallet rejects it with "Transaction recentBlockhash required".
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const tx = buildTx({ blockhash, lastValidBlockHeight })
    let signature
    if (typeof provider.signAndSendTransaction === 'function') {
      const sent = await provider.signAndSendTransaction(tx)
      signature = sent?.signature || sent?.publicKey || null
    } else if (typeof provider.signTransaction === 'function') {
      const signed = await provider.signTransaction(tx)
      signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 })
    } else {
      throw new Error('Wallet does not support signing')
    }
    if (!signature) throw new Error('Wallet returned no signature')
    try {
      await waitForConfirmation(conn, signature, 90_000)
      return signature
    } catch (err) {
      lastErr = err
      const msg = String(err?.message || err).toLowerCase()
      const isExpiry =
        msg.includes('block height exceeded') ||
        msg.includes('has expired') ||
        msg.includes('not confirmed within') ||
        msg.includes('blockhash not found')
      if (!isExpiry || attempt === maxAttempts - 1) throw err
      // Loop and retry with a fresh blockhash + re-sign.
    }
  }
  throw lastErr
}

// Cumulative delegated amount for orders sharing the SAME inputMint (i.e.
// draining the same user ATA). spl-token approve replaces the prior
// delegation on a token account, so we re-approve the running total of
// all this user's active orders that target the same mint. Orders on
// different mints (e.g. limit BUY on USDC + stop-loss SELL on outcome
// token) are independent delegations and aren't summed together.
//
// Order shape from `listOrders`: { input_mint, amount_usdc, trigger_price,
// order_type, status, ... }.
function sumActiveAtomicForMint(orders, inputMint) {
  let totalAtomic = 0
  for (const o of orders ?? []) {
    if (!o) continue
    const status = o.status
    if (status !== 'pending' && status !== 'armed' && status !== 'submitting') continue
    // Older durable-nonce-flow rows don't carry `input_mint` — we only
    // sum approval-flow rows. Legacy rows have their own per-tx delegation
    // (none) and shouldn't double-count against the approval pool anyway.
    const orderInputMint = o.input_mint ?? null
    if (!orderInputMint || orderInputMint !== inputMint) continue
    const usd = Number(o.amount_usdc ?? o.amount ?? 0)
    if (!Number.isFinite(usd) || usd <= 0) continue
    const orderType = o.order_type ?? o.orderType ?? 'limit'
    if (orderType === 'stop-loss' || orderType === 'take-profit') {
      // Sells are denominated in shares: shares = usd / triggerPrice.
      const trigger = Number(o.trigger_price ?? o.triggerPrice ?? 0)
      if (trigger > 0) {
        totalAtomic += Math.floor((usd / trigger) * Math.pow(10, OUTCOME_DECIMALS))
      }
    } else {
      // Buys are denominated in USDC.
      totalAtomic += Math.floor(usd * Math.pow(10, USDC_DECIMALS))
    }
  }
  return totalAtomic
}

export function useKeeperApprovalOrder() {
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
    if (orderType !== 'limit' && orderType !== 'stop-loss' && orderType !== 'take-profit') {
      throw new Error(`Unsupported orderType: ${orderType}`)
    }

    const outcomeMint = side === 'yes' ? market.yesMint : market.noMint
    if (!outcomeMint) throw new Error('Market lacks tradeable outcome mints')

    const isSell = orderType === 'stop-loss' || orderType === 'take-profit'
    // Direction: limit = USDC → outcome (BUY). SL/TP = outcome → USDC (SELL).
    const inputMintStr = isSell ? outcomeMint : USDC_MINT
    const outputMintStr = isSell ? USDC_MINT : outcomeMint
    // Sells are denominated in shares (= amountUsdc / triggerPrice). Buys
    // are denominated in USDC. Decimals are 6 for both, so we apply 1e6
    // either way.
    const newAtomic = isSell
      ? Math.floor((amountUsdc / triggerPrice) * Math.pow(10, OUTCOME_DECIMALS))
      : Math.floor(amountUsdc * Math.pow(10, USDC_DECIMALS))
    if (!(newAtomic > 0)) throw new Error('Computed atomic amount is non-positive')

    // 1. Auth.
    await ensureSession(activeWallet, address)

    // 2. Resolve the executor pubkey from the keeper.
    const config = await getConfig({ refresh: false })
    if (!config?.executor) {
      throw new Error('Keeper executor not configured — contact support')
    }
    const executor = new PublicKey(config.executor)

    // 3. Pre-flight: refuse if a non-terminal order already exists for
    //    this market. The server enforces the same rule (409); doing it
    //    here saves the wallet popup.
    try {
      const existing = await listOrders({ market: market.ticker })
      const live = (existing?.orders ?? []).find((o) =>
        o.status === 'pending' || o.status === 'armed' || o.status === 'submitting'
      )
      if (live) {
        throw new Error(
          'You already have an active order for this market. Cancel it before placing another.',
        )
      }
    } catch (err) {
      if (err?.message?.startsWith('You already have')) throw err
      // listOrders failed transiently — let the server be the final word.
    }

    // 4. Compute the cumulative delegate amount across this wallet's
    //    active orders that share the SAME inputMint. Orders on different
    //    mints are separate spl-token delegations.
    let cumulative
    try {
      const all = await listOrders({})  // all markets, all statuses
      cumulative = sumActiveAtomicForMint(all?.orders, inputMintStr)
    } catch {
      cumulative = 0
    }
    const totalDelegated = cumulative + newAtomic

    // 5. Build the spl-token approve tx (and bundle ATA-create-idempotent
    //    so first-time users don't need a separate funding step). User
    //    signs with whichever wallet they have — Phantom included; the
    //    Lighthouse wrapper is fine here because this tx doesn't use
    //    durable nonces and instruction order doesn't matter.
    const userPubkey = new PublicKey(address)
    const inputMint = new PublicKey(inputMintStr)
    const userATA = getAssociatedTokenAddressSync(inputMint, userPubkey)

    const provider = activeWallet?.getProvider?.()
    if (!provider) throw new Error('Wallet provider unavailable')

    const conn = new Connection(rpcUrl(), 'confirmed')
    const executorATA = getAssociatedTokenAddressSync(inputMint, executor)
    // Decimals: USDC and outcome tokens are both 6. Use a single constant.
    const inputDecimals = isSell ? OUTCOME_DECIMALS : USDC_DECIMALS

    // 6. Build → sign → send → confirm with retry on blockhash expiry.
    //    If the user takes >60s in the wallet popup, the recentBlockhash
    //    ages out and confirmTransaction rejects with "block height
    //    exceeded". Refetch and re-sign once before giving up.
    const buildTx = ({ blockhash, lastValidBlockHeight }) => {
      const tx = new Transaction({ feePayer: userPubkey, blockhash, lastValidBlockHeight })
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          userPubkey, userATA, userPubkey, inputMint,
        ),
      )
      tx.add(
        createApproveCheckedInstruction(
          userATA, inputMint, executor, userPubkey,
          BigInt(totalDelegated), inputDecimals, [], TOKEN_PROGRAM_ID,
        ),
      )
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          userPubkey, executorATA, executor, inputMint,
        ),
      )
      return tx
    }
    const signature = await signSendConfirm({ provider, conn, buildTx })

    // 8. Register the order with the keeper.
    const order = await placeOrder({
      flow: 'approval',
      marketTicker: market.ticker,
      marketId: market.id,
      eventTicker: market.eventTicker,
      side,
      orderType,
      triggerPrice,
      amountUsdc,
      yesMint: market.yesMint,
      noMint: market.noMint,
      approvalSignature: signature,
      delegatedAmountAtPlacement: totalDelegated,
      userInputAta: userATA.toBase58(),
      inputMint: inputMintStr,
      outputMint: outputMintStr,
    })

    return order
  }, [connected, connect, address, activeWallet, requireKyc, verifyWithServer])

  // Build + send `revoke` instructions for each ATA the user has delegated
  // to the executor. Pass `mints` to scope (defaults to USDC). Cancels any
  // non-terminal keeper orders that drain those mints first so the keeper
  // stops trying to fire against a wiped delegation.
  const revokeApproval = useCallback(async ({ mints } = {}) => {
    if (!connected) { connect(); throw new Error('Connect wallet first') }
    const userPubkey = new PublicKey(address)
    const mintList = (mints && mints.length > 0) ? mints : [USDC_MINT]

    // Cancel pending/armed/submitting keeper orders for these mints up
    // front. If the on-chain revoke lands first, the keeper would try to
    // fire and burn an order to `failed` for no reason.
    if (isKeeperConfigured() && getSession()) {
      try {
        await cancelOrdersByMint({ mints: mintList })
      } catch (err) {
        console.warn('cancel_orders_by_mint_failed', err)
      }
    }

    const atas = mintList.map((m) => ({
      mint: new PublicKey(m),
      ata: getAssociatedTokenAddressSync(new PublicKey(m), userPubkey),
    }))

    const conn = new Connection(rpcUrl(), 'confirmed')
    const provider = activeWallet?.getProvider?.()
    if (!provider) throw new Error('Wallet provider unavailable')

    const buildTx = ({ blockhash, lastValidBlockHeight }) => {
      const tx = new Transaction({ feePayer: userPubkey, blockhash, lastValidBlockHeight })
      for (const { ata } of atas) {
        tx.add(createRevokeInstruction(ata, userPubkey, [], TOKEN_PROGRAM_ID))
      }
      return tx
    }
    const signature = await signSendConfirm({ provider, conn, buildTx })
    return { signature }
  }, [connected, connect, address, activeWallet])

  return { placeLimit, revokeApproval }
}
