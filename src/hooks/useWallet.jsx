import React, { useState, useEffect, useCallback, createContext, useContext } from 'react'

export const WalletContext = createContext(null)

// Crude, sufficient for routing logic: is the current browser a mobile one?
// We only use this to switch from "open installer" to "open wallet's
// universal link" — false positives just send the user to the download page.
function isMobileDevice() {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
}

// Phantom and Solflare both expose a deep-link that instructs their mobile
// app to open a target URL inside their in-app browser, where `window.solana`
// / `window.solflare` are injected. We hand them the current page so the user
// lands back here and the normal injected-provider flow takes over.
//
// Backpack mobile does not have a public equivalent yet — fall back to the
// download URL. If the spec lands we can slot it in alongside the others.
function mobileDeepLink(walletId) {
  if (typeof window === 'undefined') return null
  const here = encodeURIComponent(window.location.href)
  const ref = encodeURIComponent(window.location.origin)
  switch (walletId) {
    case 'phantom':
      return `https://phantom.app/ul/browse/${here}?ref=${ref}`
    case 'solflare':
      return `https://solflare.com/ul/v1/browse/${here}?ref=${ref}`
    default:
      return null
  }
}

export const WALLETS = [
  {
    id: 'phantom',
    name: 'Phantom',
    icon: 'https://phantom.app/img/phantom-logo.svg',
    getProvider: () => window.solana?.isPhantom ? window.solana : null,
    downloadUrl: 'https://phantom.app/download',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    icon: 'https://solflare.com/favicon.ico',
    getProvider: () => window.solflare?.isSolflare ? window.solflare : null,
    downloadUrl: 'https://solflare.com/download',
  },
  {
    id: 'backpack',
    name: 'Backpack',
    icon: 'https://backpack.app/favicon.ico',
    getProvider: () => window.backpack?.isBackpack
      ? window.backpack
      : (window.xnft?.solana || null),
    downloadUrl: 'https://backpack.app/downloads',
  },
]

export function WalletProvider({ children }) {
  const [address, setAddress] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [walletAvailable, setWalletAvailable] = useState(false)
  const [activeWalletId, setActiveWalletId] = useState(null)
  const [showPicker, setShowPicker] = useState(false)
  const [availableWallets, setAvailableWallets] = useState([])
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    setIsMobile(isMobileDevice())
    const check = () => {
      const hasSolflare = !!window.solflare?.isSolflare
      const hasPhantom = !!window.solana?.isPhantom
      setWalletAvailable(hasSolflare || hasPhantom)

      const available = WALLETS.filter(w => w.getProvider() !== null)
      setAvailableWallets(available)

      const saved = localStorage.getItem('predictflow_wallet')
      const savedWallet = localStorage.getItem('predictflow_wallet_id')
      if (saved) {
        setAddress(saved)
        setActiveWalletId(savedWallet)
      }
    }
    check()
    const timer = setTimeout(check, 1000)
    return () => clearTimeout(timer)
  }, [])

  const connectWallet = useCallback(async (walletId) => {
    setConnecting(true)
    setShowPicker(false)
    try {
      const wallet = WALLETS.find(w => w.id === walletId)
      if (!wallet) throw new Error('Unknown wallet')

      const provider = wallet.getProvider()
      if (!provider) {
        // On mobile, prefer wallet deep-link over download so the user can
        // complete the connect flow in a single tap.
        const deep = isMobileDevice() ? mobileDeepLink(walletId) : null
        const target = deep || wallet.downloadUrl
        // eslint-disable-next-line no-restricted-globals
        window.location.href = target
        setConnecting(false)
        return
      }

      const resp = await provider.connect()
      const pubkey = resp.publicKey?.toString() || provider.publicKey?.toString()

      if (pubkey) {
        setAddress(pubkey)
        setActiveWalletId(walletId)
        localStorage.setItem('predictflow_wallet', pubkey)
        localStorage.setItem('predictflow_wallet_id', walletId)
      }
    } catch {
      // user rejected or provider threw — surface nothing; UI stays in disconnected state
    } finally {
      setConnecting(false)
    }
  }, [])

  const connect = useCallback(() => {
    // If only one wallet is available, connect directly
    const available = WALLETS.filter(w => w.getProvider() !== null)
    if (available.length === 1) {
      connectWallet(available[0].id)
    } else if (available.length > 1) {
      setShowPicker(true)
    } else {
      // No wallets detected, show picker with download links
      setShowPicker(true)
    }
  }, [connectWallet])

  const disconnect = useCallback(async () => {
    try {
      const wallet = WALLETS.find(w => w.id === activeWalletId)
      const provider = wallet?.getProvider()
      if (provider) {
        await provider.disconnect()
      }
    } catch {
      // ignore
    }
    setAddress(null)
    setActiveWalletId(null)
    localStorage.removeItem('predictflow_wallet')
    localStorage.removeItem('predictflow_wallet_id')
  }, [activeWalletId])

  const shortAddress = address
    ? `${address.slice(0, 4)}...${address.slice(-4)}`
    : null

  const activeWallet = WALLETS.find(w => w.id === activeWalletId) || null

  return (
    <WalletContext.Provider value={{
      address,
      shortAddress,
      connecting,
      walletAvailable,
      connect,
      connectWallet,
      disconnect,
      connected: !!address,
      activeWallet,
      activeWalletId,
      showPicker,
      setShowPicker,
      availableWallets,
      isMobile,
    }}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used within WalletProvider')
  return ctx
}
