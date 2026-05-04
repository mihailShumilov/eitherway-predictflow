import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { KYC_CHECK_URL } from '../config/env'
import { WalletContext } from './useWallet'
import { fetchWithRetry } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { track, setUserProperties } from '../lib/analytics'

const KycContext = createContext(null)

const STORAGE_KEY = 'predictflow_kyc_status'
const REMOTE_POLL_INTERVAL_MS = 8000

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

// Optionally check with a backend. When VITE_KYC_CHECK_URL is set, we POST
// `{ wallet }` and expect `{ verified: boolean, expiresAt?: string }` back.
// When unset, KYC is pure client-side self-attestation (demo mode).
async function checkRemoteKyc(wallet) {
  if (!KYC_CHECK_URL || !wallet) return null
  try {
    const res = await fetchWithRetry(KYC_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet }),
    }, { retries: 1, timeoutMs: 6000 })
    if (!res.ok) throw new Error(`KYC check ${res.status}`)
    const data = await res.json()
    return { verified: !!data.verified, expiresAt: data.expiresAt || null }
  } catch (err) {
    reportError(err, { context: 'checkRemoteKyc' })
    return null
  }
}

export function KycProvider({ children }) {
  const [status, setStatus] = useState(loadStatus)
  const statusRef = useRef(status)
  const [showModal, setShowModalState] = useState(false)
  const [reason, setReason] = useState(null)
  // Read the wallet context directly so this provider stays usable in
  // tests/storybooks where WalletProvider isn't mounted. `address` is null
  // when the context is absent — KYC then falls back to demo/self-attestation.
  const wallet = useContext(WalletContext)
  const address = wallet?.address ?? null
  const pollRef = useRef(null)
  const hasBackend = !!KYC_CHECK_URL

  useEffect(() => {
    statusRef.current = status
    saveStatus(status)
  }, [status])

  // When a backend is configured, the wallet is the source of truth —
  // sync on wallet change and poll while we're waiting on Proof. Read
  // from statusRef so stale-closure flips (pending → verified → pending)
  // are impossible.
  useEffect(() => {
    if (!hasBackend) return

    let cancelled = false
    async function syncOnce() {
      if (!address) return
      const remote = await checkRemoteKyc(address)
      if (cancelled || !remote) return
      const current = statusRef.current
      setStatus(remote.verified ? 'verified' : (current === 'pending' ? 'pending' : 'unverified'))
    }
    syncOnce()

    if (status === 'pending' && address) {
      pollRef.current = setInterval(syncOnce, REMOTE_POLL_INTERVAL_MS)
      return () => {
        cancelled = true
        if (pollRef.current) clearInterval(pollRef.current)
      }
    }
    return () => { cancelled = true }
  }, [address, status, hasBackend])

  // Public setter: opening the modal without a reason clears any stale upstream
  // rejection text so the default explainer is shown.
  const setShowModal = useCallback((open) => {
    if (open) track('kyc_modal_opened', { status, source: 'manual' })
    setShowModalState(open)
    if (!open) setReason(null)
  }, [status])

  // Open the modal with an upstream rejection message (e.g. DFlow /order 403).
  // The message is rendered below the static copy so the user knows *why*
  // trading was just blocked.
  const showModalWithReason = useCallback((msg) => {
    const cleaned = typeof msg === 'string' && msg.trim() ? msg.trim() : null
    track('kyc_modal_opened', { status, source: 'gate_rejection', has_reason: !!cleaned })
    setReason(cleaned)
    setShowModalState(true)
  }, [status])

  const requireKyc = useCallback(() => {
    if (status === 'verified') return true
    track('kyc_modal_opened', { status, source: 'require_kyc' })
    setReason(null)
    setShowModalState(true)
    return false
  }, [status])

  // Authoritative check just-in-time before a trade. When a backend is
  // configured, always re-verify against it — the client-side boolean is
  // just a UX hint, the server is the source of truth.
  const verifyWithServer = useCallback(async () => {
    if (!hasBackend) return status === 'verified'
    if (!address) return false
    const remote = await checkRemoteKyc(address)
    if (remote?.verified) {
      setStatus('verified')
      return true
    }
    setStatus('unverified')
    setReason(null)
    setShowModalState(true)
    return false
  }, [hasBackend, address, status])

  const markPending = useCallback(() => {
    setStatus('pending')
    setUserProperties({ kyc_status: 'pending' })
  }, [])
  const markVerified = useCallback(() => {
    setStatus('verified')
    setUserProperties({ kyc_status: 'verified', kyc_verified_at: new Date().toISOString() })
    track('kyc_verified', {})
    setReason(null)
    setShowModalState(false)
  }, [])
  const reset = useCallback(() => {
    setStatus('unverified')
    setUserProperties({ kyc_status: 'unverified' })
  }, [])

  return (
    <KycContext.Provider value={{
      status,
      verified: status === 'verified',
      hasBackend,
      showModal,
      reason,
      setShowModal,
      showModalWithReason,
      requireKyc,
      verifyWithServer,
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
