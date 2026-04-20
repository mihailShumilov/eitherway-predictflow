import React, { useState, useEffect, useCallback, createContext, useContext } from 'react'

const WalletContext = createContext(null)

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
]

export function WalletProvider({ children }) {
  const [address, setAddress] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [walletAvailable, setWalletAvailable] = useState(false)
  const [activeWalletId, setActiveWalletId] = useState(null)
  const [showPicker, setShowPicker] = useState(false)
  const [availableWallets, setAvailableWallets] = useState([])

  useEffect(() => {
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
        window.open(wallet.downloadUrl, '_blank')
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
    } catch (err) {
      console.error('Wallet connect error:', err)
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
