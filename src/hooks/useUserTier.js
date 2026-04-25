// useUserTier — subscribes to tier changes for the connected wallet. Tier
// state lives in localStorage; this hook re-reads on wallet change and on
// the custom 'predictflow:tier-change' event we dispatch from setUserTier
// callers (UpgradeModal). That avoids a polling loop and stays in sync
// across components in the same tab.

import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './useWallet'
import { getUserTier, setUserTier as persistTier, getTierExpiry, getTierConfig } from '../services/feeService'

const TIER_CHANGE_EVENT = 'predictflow:tier-change'

export function emitTierChange(walletPubkey) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TIER_CHANGE_EVENT, { detail: { walletPubkey } }))
}

export function useUserTier() {
  const { address } = useWallet()
  const [tier, setTier] = useState(() => getUserTier(address))
  const [expiry, setExpiry] = useState(() => getTierExpiry(address))

  useEffect(() => {
    setTier(getUserTier(address))
    setExpiry(getTierExpiry(address))
  }, [address])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => {
      setTier(getUserTier(address))
      setExpiry(getTierExpiry(address))
    }
    window.addEventListener(TIER_CHANGE_EVENT, handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(TIER_CHANGE_EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [address])

  const upgradeTier = useCallback((nextTier, opts) => {
    if (!address) return
    persistTier(address, nextTier, opts)
    setTier(getUserTier(address))
    setExpiry(getTierExpiry(address))
    emitTierChange(address)
  }, [address])

  return {
    tier,
    tierConfig: getTierConfig(tier),
    expiry,
    upgradeTier,
    isPro: tier === 'PRO' || tier === 'WHALE',
    isWhale: tier === 'WHALE',
    isFree: tier === 'FREE',
  }
}
