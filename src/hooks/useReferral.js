// useReferral — exposes the connected wallet's own referral code and stats,
// plus the active referrer captured from a ?ref= URL param. Self-referrals
// are filtered out by getActiveReferrerWallet.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from './useWallet'
import {
  generateReferralCode,
  getReferralLink,
  getReferralStats,
  getActiveReferrerWallet,
  registerReferralCode,
} from '../services/referralService'
import { track, setUserProperties } from '../lib/analytics'

export function useReferral() {
  const { address } = useWallet()
  const [stats, setStats] = useState({ earned: 0, count: 0 })

  // Auto-register every connecting wallet's code so other users' referral
  // links can resolve back to a pubkey for fee splits.
  useEffect(() => {
    if (address) registerReferralCode(address)
  }, [address])

  useEffect(() => {
    setStats(getReferralStats(address))
    if (typeof window === 'undefined') return
    const handler = () => setStats(getReferralStats(address))
    window.addEventListener('storage', handler)
    window.addEventListener('predictflow:referral-update', handler)
    return () => {
      window.removeEventListener('storage', handler)
      window.removeEventListener('predictflow:referral-update', handler)
    }
  }, [address])

  const code = useMemo(() => generateReferralCode(address), [address])
  const link = useMemo(() => getReferralLink(code), [code])
  const referrer = useMemo(() => getActiveReferrerWallet(address), [address])

  // Fire once whenever a referrer first becomes visible for this wallet —
  // equivalent to "this user is attributed to <referrer>". Stable via ref so
  // we don't re-fire on every memo recomputation.
  const reportedReferrerRef = useRef(null)
  useEffect(() => {
    if (referrer && reportedReferrerRef.current !== referrer) {
      reportedReferrerRef.current = referrer
      track('referral_applied', { referrer_wallet: referrer, wallet_address: address })
      setUserProperties({ referrer_wallet: referrer })
    }
  }, [referrer, address])

  return { code, link, stats, referrer, hasReferrer: !!referrer }
}

export function emitReferralUpdate() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('predictflow:referral-update'))
}
