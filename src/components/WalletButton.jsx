import React, { useState, useRef, useEffect } from 'react'
import { Wallet, ChevronDown, LogOut, Copy, ExternalLink, Check, X, Download } from 'lucide-react'
import { useWallet, WALLETS } from '../hooks/useWallet'

function WalletPickerModal() {
  const { showPicker, setShowPicker, connectWallet, isMobile } = useWallet()

  if (!showPicker) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowPicker(false)} />
      <div className="relative bg-terminal-surface border border-terminal-border rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-terminal-border">
          <h3 className="text-sm font-semibold text-white">Connect Wallet</h3>
          <button
            onClick={() => setShowPicker(false)}
            className="p-1 rounded text-terminal-muted hover:text-white hover:bg-terminal-highlight transition-all"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-2">
          {WALLETS.map(wallet => {
            const isAvailable = wallet.getProvider() !== null
            const mobileDeepLinkable = isMobile && (wallet.id === 'phantom' || wallet.id === 'solflare')
            const subtitle = isAvailable
              ? 'Detected'
              : mobileDeepLinkable
                ? 'Open in mobile app'
                : 'Not installed'
            return (
              <button
                key={wallet.id}
                onClick={() => {
                  // connectWallet handles both injected + mobile-deep-link branches.
                  connectWallet(wallet.id)
                }}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-lg border border-terminal-border hover:border-terminal-accent/50 hover:bg-terminal-card transition-all group"
              >
                <div className="w-10 h-10 rounded-lg bg-terminal-card flex items-center justify-center overflow-hidden border border-terminal-border">
                  {wallet.id === 'phantom' ? (
                    <svg viewBox="0 0 128 128" className="w-6 h-6">
                      <rect width="128" height="128" rx="26" fill="#AB9FF2"/>
                      <path d="M110.584 64.9142H99.142C99.142 41.7651 80.173 23 56.7724 23C33.7647 23 15.0535 41.1088 14.4135 63.6866C13.7534 87.0854 33.2533 107 56.9098 107H61.4484C82.4047 107 110.584 88.7578 110.584 64.9142Z" fill="url(#paint0_linear)"/>
                      <path d="M77.5765 60.6392C77.5765 63.8747 75.1498 66.4984 72.1584 66.4984C69.167 66.4984 66.7402 63.8747 66.7402 60.6392C66.7402 57.4037 69.167 54.78 72.1584 54.78C75.1498 54.78 77.5765 57.4037 77.5765 60.6392Z" fill="white"/>
                      <path d="M94.3683 60.6392C94.3683 63.8747 91.9415 66.4984 88.9501 66.4984C85.9587 66.4984 83.532 63.8747 83.532 60.6392C83.532 57.4037 85.9587 54.78 88.9501 54.78C91.9415 54.78 94.3683 57.4037 94.3683 60.6392Z" fill="white"/>
                      <defs><linearGradient id="paint0_linear" x1="64" y1="23" x2="64" y2="107" gradientUnits="userSpaceOnUse"><stop stopColor="#534BB1"/><stop offset="1" stopColor="#551BF9"/></linearGradient></defs>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 32 32" className="w-6 h-6">
                      <rect width="32" height="32" rx="6" fill="#FC822B"/>
                      <path d="M16 6L8 16l8 10 8-10L16 6z" fill="white"/>
                    </svg>
                  )}
                </div>
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium text-terminal-text group-hover:text-white transition-colors">
                    {wallet.name}
                  </p>
                  <p className="text-[10px] text-terminal-muted">{subtitle}</p>
                </div>
                {isAvailable ? (
                  <div className="w-2 h-2 rounded-full bg-terminal-green" />
                ) : (
                  <Download size={14} className="text-terminal-muted" />
                )}
              </button>
            )
          })}
        </div>
        <div className="px-5 py-3 border-t border-terminal-border">
          <p className="text-[10px] text-terminal-muted text-center">
            By connecting, you agree to the terms of service
          </p>
        </div>
      </div>
    </div>
  )
}

export default function WalletButton() {
  const { address, shortAddress, connecting, connected, connect, disconnect, activeWallet, showPicker } = useWallet()
  const [showMenu, setShowMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const copyAddress = () => {
    if (address) {
      navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <>
      {!connected ? (
        <button
          onClick={connect}
          disabled={connecting}
          className="flex items-center gap-2 px-4 py-2 bg-terminal-accent hover:bg-blue-600 text-white rounded-lg font-medium text-sm transition-all duration-200 disabled:opacity-50"
        >
          <Wallet size={16} />
          {connecting ? 'Connecting...' : 'Connect Wallet'}
        </button>
      ) : (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="flex items-center gap-2 px-4 py-2 bg-terminal-card border border-terminal-border hover:border-terminal-accent text-terminal-text rounded-lg font-mono text-sm transition-all duration-200"
          >
            <div className="w-2 h-2 rounded-full bg-terminal-green animate-pulse" />
            {activeWallet && (
              <span className="text-[10px] text-terminal-muted hidden sm:inline">
                {activeWallet.name}
              </span>
            )}
            {shortAddress}
            <ChevronDown size={14} className={`transition-transform ${showMenu ? 'rotate-180' : ''}`} />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-terminal-surface border border-terminal-border rounded-lg shadow-2xl z-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-terminal-border">
                <div className="flex items-center gap-2">
                  {activeWallet && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-terminal-card border border-terminal-border rounded text-terminal-accent">
                      {activeWallet.name}
                    </span>
                  )}
                  <span className="text-xs text-terminal-green">Connected</span>
                </div>
                <p className="font-mono text-sm text-terminal-text truncate mt-1">{address}</p>
              </div>
              <button
                onClick={copyAddress}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-terminal-text hover:bg-terminal-highlight transition-colors"
              >
                {copied ? <Check size={14} className="text-terminal-green" /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Address'}
              </button>
              <a
                href={`https://solscan.io/account/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-terminal-text hover:bg-terminal-highlight transition-colors"
              >
                <ExternalLink size={14} />
                View on Solscan
              </a>
              <button
                onClick={() => { disconnect(); setShowMenu(false) }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-terminal-red hover:bg-terminal-highlight transition-colors border-t border-terminal-border"
              >
                <LogOut size={14} />
                Disconnect
              </button>
            </div>
          )}
        </div>
      )}
      <WalletPickerModal />
    </>
  )
}
