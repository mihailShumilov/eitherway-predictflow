import React, { useState } from 'react'
import { Activity, RefreshCw, Wifi, WifiOff, LayoutGrid, Wallet, Info, Sparkles } from 'lucide-react'
import WalletButton from './WalletButton'
import SearchBar from './SearchBar'
import AboutModal from './AboutModal'
import TierBadge from './monetization/TierBadge'
import { useMarkets } from '../hooks/useMarkets'
import { useHealth } from '../hooks/useHealth'
import { useWallet } from '../hooks/useWallet'

const NAV_ITEMS = [
  { id: 'explore', label: 'Explore', icon: LayoutGrid },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'pricing', label: 'Pricing', icon: Sparkles },
]

export default function Header({ page, onPageChange }) {
  const { usingMockData, allMarkets, refresh, loading } = useMarkets()
  const { dflow: dflowOk, rpc: rpcOk } = useHealth()
  const { connected } = useWallet()
  const [aboutOpen, setAboutOpen] = useState(false)
  const anyDegraded = dflowOk === false || rpcOk === false

  return (
    <header className="bg-terminal-surface border-b border-terminal-border sticky top-0 z-40">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => onPageChange?.('explore')}
            className="flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-terminal-accent"
            aria-label="PredictFlow home"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-terminal-accent to-terminal-cyan flex items-center justify-center">
              <Activity size={18} className="text-white" />
            </div>
            <div className="text-left">
              <h1 className="text-lg font-bold text-white tracking-tight leading-none">
                PredictFlow
              </h1>
              <p className="text-[10px] text-terminal-muted uppercase tracking-widest leading-none mt-0.5">
                DFlow Terminal
              </p>
            </div>
          </button>

          <div className="hidden md:block h-8 w-px bg-terminal-border" />

          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map(item => {
              const Icon = item.icon
              const active = page === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => onPageChange?.(item.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                    active
                      ? 'bg-terminal-highlight text-white'
                      : 'text-terminal-muted hover:text-terminal-text hover:bg-terminal-card'
                  }`}
                >
                  <Icon size={12} />
                  {item.label}
                </button>
              )
            })}
          </nav>

          <div className="hidden md:block h-8 w-px bg-terminal-border" />

          <div className="hidden md:flex items-center gap-3 text-xs">
            <div
              className="flex items-center gap-1.5"
              title={anyDegraded
                ? `Degraded: ${dflowOk === false ? 'DFlow ' : ''}${rpcOk === false ? 'RPC' : ''}`
                : usingMockData ? 'Running on mock market data' : 'Connected to DFlow'}
            >
              {usingMockData || anyDegraded ? (
                <WifiOff size={12} className={anyDegraded ? 'text-terminal-red' : 'text-terminal-yellow'} />
              ) : (
                <Wifi size={12} className="text-terminal-green" />
              )}
              <span className={
                anyDegraded ? 'text-terminal-red'
                  : usingMockData ? 'text-terminal-yellow'
                    : 'text-terminal-green'
              }>
                {anyDegraded ? 'DEGRADED' : usingMockData ? 'DEMO' : 'LIVE'}
              </span>
            </div>
            <div className="text-terminal-muted">
              <span className="font-mono">{allMarkets.length}</span> markets
            </div>
          </div>
        </div>

        <div className="flex-1 max-w-xl mx-4 hidden lg:block">
          {page !== 'portfolio' && <SearchBar />}
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          {page !== 'portfolio' && (
            <button
              onClick={refresh}
              disabled={loading}
              className="p-2 rounded-lg text-terminal-muted hover:text-terminal-text hover:bg-terminal-highlight transition-all disabled:opacity-50"
              title="Refresh markets"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            onClick={() => setAboutOpen(true)}
            className="p-2 rounded-lg text-terminal-muted hover:text-terminal-text hover:bg-terminal-highlight transition-all"
            title="About PredictFlow"
            aria-label="About PredictFlow"
          >
            <Info size={16} />
          </button>
          {connected && (
            <TierBadge onClick={() => onPageChange?.('pricing')} />
          )}
          <WalletButton />
        </div>
      </div>
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      <nav className="md:hidden flex items-center gap-1 px-4 pb-2">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon
          const active = page === item.id
          return (
            <button
              key={item.id}
              onClick={() => onPageChange?.(item.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                active
                  ? 'bg-terminal-highlight text-white'
                  : 'text-terminal-muted hover:text-terminal-text hover:bg-terminal-card'
              }`}
            >
              <Icon size={12} />
              {item.label}
            </button>
          )
        })}
      </nav>

      {page !== 'portfolio' && (
        <div className="lg:hidden px-4 pb-3">
          <SearchBar />
        </div>
      )}
    </header>
  )
}
