// useReferral — exposes the connected wallet's own referral code and stats,
// plus the active referrer captured from a ?ref= URL param. Self-referrals
// are filtered out by getActiveReferrerWallet.

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from './useWallet'
import {
  generateReferralCode,
  getReferralLink,
  getReferralStats,
  getActiveReferrerWallet,
  registerReferralCode,
} from '../services/referralService'

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

  return { code, link, stats, referrer, hasReferrer: !!referrer }
}

export function emitReferralUpdate() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('predictflow:referral-update'))
}
