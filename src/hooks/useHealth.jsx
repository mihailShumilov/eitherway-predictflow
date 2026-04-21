import React, { createContext, useContext, useEffect, useState, useRef } from 'react'
import { DFLOW_PROXY_BASE, DFLOW_WS_URL, SOLANA_RPC_ENDPOINTS } from '../config/env'

const HealthContext = createContext(null)

const POLL_INTERVAL_MS = 60000
const TIMEOUT_MS = 4000

async function probeOnce(url, method = 'GET') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { method, signal: controller.signal, cache: 'no-store' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function probeRpc(endpoint) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      cache: 'no-store',
    })
    return res.ok
  } catch {
    return false
  }
}

export function HealthProvider({ children }) {
  const [status, setStatus] = useState({
    dflow: null,      // null = checking, true = ok, false = down
    rpc: null,
    ws: null,
    lastChecked: null,
  })
  const timerRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    async function runChecks() {
      const [dflow, rpc] = await Promise.all([
        probeOnce(`${DFLOW_PROXY_BASE}/api/v1/events?status=active&limit=1`),
        Promise.any(SOLANA_RPC_ENDPOINTS.map(probeRpc)).catch(() => false),
      ])
      if (cancelled) return
      setStatus(s => ({ ...s, dflow, rpc, lastChecked: new Date().toISOString() }))
    }

    runChecks()
    timerRef.current = setInterval(runChecks, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // Note: WS status is set by the LivePrices provider via setWsStatus.
  const setWsStatus = (ok) => setStatus(s => ({ ...s, ws: ok }))

  const allHealthy = status.dflow !== false && status.rpc !== false
  return (
    <HealthContext.Provider value={{ ...status, allHealthy, setWsStatus }}>
      {children}
    </HealthContext.Provider>
  )
}

export function useHealth() {
  return useContext(HealthContext) || {
    dflow: null, rpc: null, ws: null, lastChecked: null, allHealthy: true, setWsStatus: () => {},
  }
}
