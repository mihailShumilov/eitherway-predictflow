// Fee-sweep machinery — extracted from useTradeSubmit so the trade hook
// stays focused on submission logic.
//
// The sweep is a SECOND signed tx, separate from the swap. It transfers
// the platform fee (and optional referral split) from the user's USDC
// ATA to the configured fee wallet. The first tx (the swap) has already
// settled by the time we get here, so a sweep failure does NOT roll back
// the trade — we record the intent in the fee log and surface a
// non-blocking notice to the user.
//
// Cooldown: persistent sweep failures (wrong fee wallet, RPC down, user
// repeatedly rejecting the second prompt) would otherwise pop a wallet
// popup on every trade. After SWEEP_FAILURE_THRESHOLD consecutive
// failures we cool down for SWEEP_COOLDOWN_MS; a success resets the
// counter. State is module-level so it survives component remounts.

import { USDC_MINT } from '../config/env'
import { FEE_CONFIG, isFeeWalletConfigured } from '../config/fees'
import { buildFeeTransferTransaction } from './feeTransfer'

const SWEEP_FAILURE_THRESHOLD = 3
const SWEEP_COOLDOWN_MS = 5 * 60 * 1000

const sweepState = { consecutiveFailures: 0, cooldownUntil: 0 }

export function isSweepInCooldown(now = Date.now()) {
  return sweepState.cooldownUntil > now
}

export function recordSweepFailure(now = Date.now()) {
  sweepState.consecutiveFailures++
  if (sweepState.consecutiveFailures >= SWEEP_FAILURE_THRESHOLD) {
    sweepState.cooldownUntil = now + SWEEP_COOLDOWN_MS
  }
}

export function recordSweepSuccess() {
  sweepState.consecutiveFailures = 0
  sweepState.cooldownUntil = 0
}

// Build, sign, and send the fee-transfer transaction. Returns the tx
// signature on success; throws on failure (caller decides whether to
// roll back or just log).
export async function sweepFee({ address, activeWallet, feeCalc, referrer }) {
  if (!isFeeWalletConfigured()) {
    throw new Error('Fee wallet not configured — set VITE_FEE_WALLET to enable on-chain fee collection')
  }
  const provider = activeWallet?.getProvider?.()
  if (!provider) throw new Error('Wallet provider unavailable for fee transfer')

  // Math.floor a tiny fee (e.g. $0.0001 platform share with a referrer split)
  // can produce 0 lamports. A 0-amount transfer is a no-op, but its companion
  // ATA-create instruction is not — pruning here keeps the tx tight and avoids
  // surfacing nonsense entries in the admin dashboard.
  const platformLamports = Math.floor(feeCalc.platformAmount * 1e6)
  const referralLamports = Math.floor(feeCalc.referralAmount * 1e6)

  const transfers = []
  if (platformLamports > 0) {
    transfers.push({ toPubkey: FEE_CONFIG.FEE_WALLET, amountLamports: platformLamports, label: 'platform' })
  }
  if (referralLamports > 0 && referrer) {
    transfers.push({ toPubkey: referrer, amountLamports: referralLamports, label: 'referrer' })
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
