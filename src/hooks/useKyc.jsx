import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

const KycContext = createContext(null)

const STORAGE_KEY = 'predictflow_kyc_status'

// Verification levels:
//   'unverified' — never started the Proof flow
//   'pending'    — opened the Proof flow; awaiting confirmation
//   'verified'   — user has attested that Proof verification is complete
function loadStatus() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return 'unverified'
    const parsed = JSON.parse(raw)
    return parsed.status || 'unverified'
  } catch {
    return 'unverified'
  }
}

function saveStatus(status) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, updatedAt: new Date().toISOString() }))
  } catch {
    // storage full — status simply resets on reload
  }
}

export function KycProvider({ children }) {
  const [status, setStatus] = useState(loadStatus)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    saveStatus(status)
  }, [status])

  const requireKyc = useCallback(() => {
    if (status === 'verified') return true
    setShowModal(true)
    return false
  }, [status])

  const markPending = useCallback(() => setStatus('pending'), [])
  const markVerified = useCallback(() => {
    setStatus('verified')
    setShowModal(false)
  }, [])
  const reset = useCallback(() => setStatus('unverified'), [])

  return (
    <KycContext.Provider value={{
      status,
      verified: status === 'verified',
      showModal,
      setShowModal,
      requireKyc,
      markPending,
      markVerified,
      reset,
    }}>
      {children}
    </KycContext.Provider>
  )
}

export function useKyc() {
  const ctx = useContext(KycContext)
  if (!ctx) throw new Error('useKyc must be used within KycProvider')
  return ctx
}
