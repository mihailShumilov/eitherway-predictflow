import { useState, useEffect, useCallback } from 'react'
import { USDC_MINT, SPL_TOKEN_PROGRAM, SOLANA_RPC_ENDPOINTS } from '../config/env'
import { reportError } from '../lib/errorReporter'
import { maskWallet } from '../lib/privacy'

async function rpcCall(endpoint, method, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'RPC error')
  return data.result
}

async function fetchUsdcFromEndpoint(endpoint, address) {
  const result = await rpcCall(endpoint, 'getTokenAccountsByOwner', [
    address,
    { mint: USDC_MINT, programId: SPL_TOKEN_PROGRAM },
    { encoding: 'jsonParsed' },
  ])
  const accounts = result?.value || []
  return accounts.reduce((sum, acc) => {
    const amount = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount
    return sum + (typeof amount === 'number' ? amount : 0)
  }, 0)
}

export function useUsdcBalance(address) {
  const [balance, setBalance] = useState(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!address) { setBalance(null); return }
    setLoading(true)
    let lastErr
    for (const endpoint of SOLANA_RPC_ENDPOINTS) {
      try {
        const amount = await fetchUsdcFromEndpoint(endpoint, address)
        setBalance(amount)
        setLoading(false)
        return
      } catch (err) {
        lastErr = err
      }
    }
    if (lastErr) reportError(lastErr, { context: 'useUsdcBalance', wallet: maskWallet(address) })
    setBalance(null)
    setLoading(false)
  }, [address])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { balance, loading, refresh }
}
