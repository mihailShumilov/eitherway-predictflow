import React, { useState } from 'react'
import { MarketsProvider } from './hooks/useMarkets'
import { WalletProvider } from './hooks/useWallet'
import { OrdersProvider, useConditionalOrders } from './hooks/useConditionalOrders'
import { DCAProvider } from './hooks/useDCA'
import { LivePricesProvider } from './hooks/useLivePrices'
import { KycProvider } from './hooks/useKyc'
import KycModal from './components/KycModal'
import Header from './components/Header'
import CategorySidebar from './components/CategorySidebar'
import MarketGrid from './components/MarketGrid'
import MarketDetail from './components/MarketDetail'
import Positions from './components/Positions'
import Portfolio from './components/Portfolio'
import BottomBar from './components/BottomBar'
import { X, Bell, AlertTriangle } from 'lucide-react'

function OrderNotifications() {
  const { notifications, dismissNotification, pendingOrders } = useConditionalOrders()

  return (
    <>
      {/* Persistent banner when conditional orders are active */}
      {pendingOrders.length > 0 && (
        <div className="fixed top-0 left-0 right-0 z-[60] bg-terminal-yellow/10 border-b border-terminal-yellow/30 px-4 py-2 flex items-center justify-center gap-2 text-xs text-terminal-yellow">
          <AlertTriangle size={12} />
          <span className="font-medium">
            {pendingOrders.length} conditional order{pendingOrders.length !== 1 ? 's' : ''} monitoring prices.
          </span>
          <span className="text-terminal-yellow/70">Keep this tab open for orders to trigger.</span>
        </div>
      )}

      {/* Toast notifications */}
      <div className="fixed top-14 right-4 z-[70] space-y-2 w-80 pointer-events-none">
        {notifications.map(n => (
          <div
            key={n.id}
            className="pointer-events-auto bg-terminal-surface border border-terminal-accent/40 rounded-lg p-3 shadow-xl shadow-terminal-accent/10 flex items-start gap-2 animate-slide-in"
          >
            <Bell size={14} className="text-terminal-accent mt-0.5 shrink-0" />
            <p className="text-xs text-terminal-text flex-1">{n.message}</p>
            <button
              onClick={() => dismissNotification(n.id)}
              className="text-terminal-muted hover:text-terminal-text shrink-0"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function AppLayout() {
  const [selectedMarket, setSelectedMarket] = useState(null)
  const [page, setPage] = useState('explore')

  return (
    <div className="min-h-screen bg-terminal-bg text-terminal-text flex flex-col">
      <OrderNotifications />
      <KycModal />
      <Header page={page} onPageChange={setPage} />
      <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-screen-2xl mx-auto w-full">
        {page === 'explore' ? (
          <>
            <CategorySidebar />
            <main className="flex-1 min-w-0 space-y-6">
              <MarketGrid onSelectMarket={setSelectedMarket} />
              <Positions />
            </main>
          </>
        ) : (
          <main className="flex-1 min-w-0">
            <Portfolio />
          </main>
        )}
      </div>
      <BottomBar />
      {selectedMarket && (
        <MarketDetail
          market={selectedMarket}
          onClose={() => setSelectedMarket(null)}
        />
      )}
    </div>
  )
}

export default function App() {
  return (
    <WalletProvider>
      <KycProvider>
        <MarketsProvider>
          <LivePricesProvider>
            <OrdersProvider>
              <DCAProvider>
                <AppLayout />
              </DCAProvider>
            </OrdersProvider>
          </LivePricesProvider>
        </MarketsProvider>
      </KycProvider>
    </WalletProvider>
  )
}
