// Sign-in with Solana — frontend half.
//
// signIn flow:
//   1. POST /auth/challenge with the wallet pubkey.
//   2. Server returns the SIWS message text + a single-use nonce.
//   3. Wallet adapter signs the message bytes (utf-8). Most adapters
//      expose `signMessage(Uint8Array): Uint8Array` for this — it's
//      *not* a transaction sign, no on-chain side effects.
//   4. POST /auth/verify with { wallet, nonce, signature(b58) }.
//   5. Server returns a session token; we cache it under
//      `predictflow_keeper_session` with its expiry.

import bs58 from 'bs58'
import { postChallenge, postVerify, postLogout, setSession, clearSession } from './keeperApi'
import { track, identify } from './analytics'

// Backwards-compat with adapters that ship signMessage as a method on the
// provider instead of on the wallet itself.
function pickSignMessage(activeWallet) {
  const provider = activeWallet?.getProvider?.()
  if (provider?.signMessage) return (m) => provider.signMessage(m)
  if (activeWallet?.signMessage) return (m) => activeWallet.signMessage(m)
  return null
}

export async function signIn(activeWallet, walletPubkey) {
  if (!activeWallet || !walletPubkey) throw new Error('Connect wallet first')
  const signMessage = pickSignMessage(activeWallet)
  if (!signMessage) {
    throw new Error('This wallet does not support signMessage — try Phantom, Solflare, Backpack, etc.')
  }

  track('siws_signin_started', { wallet_address: walletPubkey })

  try {
    const { nonce, message } = await postChallenge(walletPubkey)
    const messageBytes = new TextEncoder().encode(message)

    const signed = await signMessage(messageBytes)
    // signMessage returns a Uint8Array (signature) directly OR an object
    // like { signature, publicKey } depending on the adapter. Normalize.
    const sigBytes = signed instanceof Uint8Array
      ? signed
      : (signed?.signature ?? signed)
    if (!(sigBytes instanceof Uint8Array)) {
      throw new Error('Wallet returned an unrecognized signMessage shape')
    }

    const signatureBase58 = bs58.encode(sigBytes)
    const result = await postVerify({
      wallet: walletPubkey,
      nonce,
      signature: signatureBase58,
    })

    setSession({
      token: result.token,
      expiresAt: result.expiresAt,
      wallet: result.wallet,
      sessionId: result.sessionId,
    })
    // Re-identify on every session mint so person properties stay current
    // even when the wallet pubkey is identical to the prior session.
    identify(result.wallet, {
      wallet_address: result.wallet,
      session_expires_at: result.expiresAt,
    })
    track('siws_signin_completed', { wallet_address: result.wallet })
    return result
  } catch (err) {
    track('siws_signin_failed', {
      wallet_address: walletPubkey,
      reason: err?.message || 'unknown',
    })
    throw err
  }
}

export async function signOut() {
  try {
    await postLogout()
  } catch {
    // best effort — clear local state regardless
  }
  clearSession()
  track('siws_signout', {})
}
