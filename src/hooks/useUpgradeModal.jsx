import React, { createContext, useCallback, useContext, useState } from 'react'
import UpgradeModal from '../components/monetization/UpgradeModal'

// Single instance of the upgrade modal at the top level of the tree, so
// any nudge anywhere in the app can open it without prop-drilling.

const UpgradeModalContext = createContext(null)

export function UpgradeModalProvider({ children }) {
  const [tier, setTier] = useState(null)

  const open = useCallback((targetTier) => {
    setTier(targetTier || 'PRO')
  }, [])
  const close = useCallback(() => setTier(null), [])

  return (
    <UpgradeModalContext.Provider value={{ open, close, isOpen: !!tier }}>
      {children}
      <UpgradeModal
        open={!!tier}
        tier={tier}
        onClose={close}
        onSuccess={close}
      />
    </UpgradeModalContext.Provider>
  )
}

export function useUpgradeModal() {
  const ctx = useContext(UpgradeModalContext)
  if (!ctx) {
    return { open: () => {}, close: () => {}, isOpen: false }
  }
  return ctx
}
