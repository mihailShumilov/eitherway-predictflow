import React, { useMemo, useEffect, Suspense, lazy } from 'react'
import { MarketsProvider, useMarkets } from './hooks/useMarkets'
import { useRoute } from './hooks/useRoute'
import { WalletProvider } from './hooks/useWallet'
import { OrdersProvider, useConditionalOrders } from './hooks/useConditionalOrders'
import { DCAProvider, useDCA } from './hooks/useDCA'
import { LivePricesProvider } from './hooks/useLivePrices'
import { KycProvider } from './hooks/useKyc'
import { HealthProvider } from './hooks/useHealth'
import { LegalModalProvider } from './hooks/useLegalModal'
import { UpgradeModalProvider } from './hooks/useUpgradeModal'
import KycModal from './components/KycModal'
import Header from './components/Header'
import CategorySidebar from './components/CategorySidebar'
import MarketGrid from './components/MarketGrid'
import Positions from './components/Positions'
import BottomBar from './components/BottomBar'
import FeeDisclosure from './components/monetization/FeeDisclosure'
import { captureReferralFromUrl } from './services/referralService'
import { X, Bell, AlertTriangle } from 'lucide-react'

// Heavy routes — defer to reduce initial bundle.
const MarketDetail = lazy(() => import('./components/MarketDetail'))
const Portfolio = lazy(() => import('./components/Portfolio'))
const PricingPage = lazy(() => import('./pages/PricingPage'))
const AdminRevenuePage = lazy(() => import('./pages/AdminRevenuePage'))

function OrderNotifications() {
  const { notifications, dismissNotification, pendingOrders } = useConditionalOrders()
  const { activeStrategies } = useDCA()
  const { usingMockData } = useMarkets()

  const tabDependentCount = pendingOrders.length + activeStrategies.length

  return (
    <>
      {/* Demo-mode banner — full width, prominent, so users know prices aren't real. */}
      {usingMockData && (
        <div className="bg-terminal-yellow/15 border-b border-terminal-yellow/40 px-4 py-2 flex items-center justify-center gap-2 text-xs text-terminal-yellow font-medium">
          <AlertTriangle size={12} />
          <span>Demo mode — markets, prices, and depth are synthetic. Connect DFlow to see live data.</span>
        </div>
      )}

      {/* Persistent banner when conditional orders or DCA are active and depend on tab staying open. */}
      {tabDependentCount > 0 && (
        <div className="bg-terminal-yellow/10 border-b border-terminal-yellow/30 px-4 py-2 flex items-center justify-center gap-2 text-xs text-terminal-yellow flex-wrap">
          <AlertTriangle size={12} />
          <span className="font-medium">
            {pendingOrders.length > 0 && (
              <>
                {pendingOrders.length} conditional order{pendingOrders.length !== 1 ? 's' : ''}
                {activeStrategies.length > 0 ? ' · ' : ' monitoring prices.'}
              </>
            )}
            {activeStrategies.length > 0 && (
              <>
                {activeStrategies.length} DCA strateg{activeStrategies.length !== 1 ? 'ies' : 'y'} running.
              </>
            )}
          </span>
          <span className="text-terminal-yellow/70">Keep this tab open — execution pauses when closed.</span>
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
  const { allMarkets, setSelectedCategory, setSelectedSubcategory } = useMarkets()
  const { page, marketTicker, side, category, subcategory, navigate } = useRoute()

  // Capture ?ref= once on first paint — referrer becomes sticky for this device.
  useEffect(() => { captureReferralFromUrl() }, [])

  // URL is source of truth for category selection — sync to provider state.
  useEffect(() => {
    setSelectedCategory(category || 'All')
    setSelectedSubcategory(subcategory || '')
  }, [category, subcategory, setSelectedCategory, setSelectedSubcategory])

  const selectedMarket = useMemo(() => {
    if (!marketTicker) return null
    const found = allMarkets.find(m => m.ticker === marketTicker)
    if (!found) return null
    return side ? { ...found, side } : found
  }, [allMarkets, marketTicker, side])

  const handleSelectMarket = (m) => {
    if (!m?.ticker) return
    navigate({ marketTicker: m.ticker, side: m.side, category, subcategory })
  }
  const handleCloseMarket = () => navigate({ page, category, subcategory })
  const handlePageChange = (p) => navigate({ page: p })

  return (
    <div className="min-h-screen bg-terminal-bg text-terminal-text flex flex-col">
      <OrderNotifications />
      <KycModal />
      <Header page={page} onPageChange={handlePageChange} />
      <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4 max-w-screen-2xl mx-auto w-full">
        {page === 'explore' && (
          <>
            <CategorySidebar />
            <main className="flex-1 min-w-0 space-y-6">
              <MarketGrid onSelectMarket={handleSelectMarket} />
              <Positions />
            </main>
          </>
        )}
        {page === 'portfolio' && (
          <main className="flex-1 min-w-0">
            <Suspense fallback={<div className="py-20 text-center text-sm text-terminal-muted">Loading portfolio…</div>}>
              <Portfolio />
            </Suspense>
          </main>
        )}
        {page === 'pricing' && (
          <main className="flex-1 min-w-0">
            <Suspense fallback={<div className="py-20 text-center text-sm text-terminal-muted">Loading pricing…</div>}>
              <PricingPage onPageChange={handlePageChange} />
            </Suspense>
          </main>
        )}
        {page === 'admin-revenue' && (
          <main className="flex-1 min-w-0">
            <Suspense fallback={<div className="py-20 text-center text-sm text-terminal-muted">Loading dashboard…</div>}>
              <AdminRevenuePage />
            </Suspense>
          </main>
        )}
      </div>
      {(page === 'explore' || page === 'pricing') && (
        <div className="px-4 pb-4 max-w-screen-2xl mx-auto w-full">
          <FeeDisclosure />
        </div>
      )}
      <BottomBar />
      {selectedMarket && (
        <Suspense fallback={null}>
          <MarketDetail
            market={selectedMarket}
            onClose={handleCloseMarket}
          />
        </Suspense>
      )}
    </div>
  )
}

export default function App() {
  return (
    <WalletProvider>
      <KycProvider>
        <HealthProvider>
          <MarketsProvider>
            <LivePricesProvider>
              <OrdersProvider>
                <DCAProvider>
                  <LegalModalProvider>
                    <UpgradeModalProvider>
                      <AppLayout />
                    </UpgradeModalProvider>
                  </LegalModalProvider>
                </DCAProvider>
              </OrdersProvider>
            </LivePricesProvider>
          </MarketsProvider>
        </HealthProvider>
      </KycProvider>
    </WalletProvider>
  )
}
