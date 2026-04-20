import { useState, useEffect, useCallback } from 'react'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const RPC_ENDPOINTS = [
  'https://api.devnet.solana.com',
  'https://api.mainnet-beta.solana.com',
]

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
    { mint: USDC_MINT, programId: TOKEN_PROGRAM_ID },
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
    for (const endpoint of RPC_ENDPOINTS) {
      try {
        const amount = await fetchUsdcFromEndpoint(endpoint, address)
        setBalance(amount)
        setLoading(false)
        return
      } catch {
        // try next endpoint
      }
    }
    setBalance(null)
    setLoading(false)
  }, [address])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { balance, loading, refresh }
}
