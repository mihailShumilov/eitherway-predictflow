import React, { createContext, useContext, useState, useCallback } from 'react'
import LegalModal from '../components/LegalModal'

const LegalModalContext = createContext(null)

export function LegalModalProvider({ children }) {
  const [activeTab, setActiveTab] = useState(null)

  const openLegal = useCallback((tab = 'terms') => setActiveTab(tab), [])
  const closeLegal = useCallback(() => setActiveTab(null), [])

  return (
    <LegalModalContext.Provider value={{ openLegal, closeLegal, activeTab }}>
      {children}
      <LegalModal
        open={activeTab !== null}
        initialTab={activeTab || 'terms'}
        onClose={closeLegal}
      />
    </LegalModalContext.Provider>
  )
}

export function useLegalModal() {
  const ctx = useContext(LegalModalContext)
  if (!ctx) throw new Error('useLegalModal must be used within LegalModalProvider')
  return ctx
}
