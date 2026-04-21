import { useState, useEffect, useCallback } from 'react'
import { useWallet } from './useWallet'
import { DFLOW_PROXY_BASE, SPL_TOKEN_PROGRAM, SOLANA_RPC_ENDPOINTS } from '../config/env'
import { fetchWithRetry } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { normalizeMarket } from '../lib/normalize'

const DFLOW_BASE = DFLOW_PROXY_BASE
const SOLANA_RPCS = SOLANA_RPC_ENDPOINTS

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'RPC error')
  return data.result
}

async function getTokenAccounts(address) {
  let lastErr
  for (const rpc of SOLANA_RPCS) {
    try {
      const result = await rpcCall(rpc, 'getTokenAccountsByOwner', [
        address,
        { programId: SPL_TOKEN_PROGRAM },
        { encoding: 'jsonParsed' },
      ])
      return result?.value || []
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('No RPC reachable')
}

// outcome_mints payload may be an array of strings, array of objects, or wrapped { mints|data: [...] }
function parseOutcomeMints(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (payload?.mints || payload?.data || payload?.outcomeMints || [])
  const index = new Map()
  for (const entry of list) {
    if (!entry) continue
    if (typeof entry === 'string') {
      index.set(entry, { mint: entry })
    } else if (typeof entry === 'object') {
      const mint = entry.mint || entry.address || entry.tokenMint || entry.outcomeMint
      if (mint) index.set(mint, entry)
    }
  }
  return index
}

// Match a wallet-held outcome token back to the user's filled positions in localStorage
// so we have an entry price for P&L. Keyed by marketId+side; if missing, entry == current.
function findLocalEntry(positions, marketId, side) {
  if (!marketId) return null
  const matches = positions.filter(p =>
    p.marketId === marketId && p.side === side && p.status === 'filled'
  )
  if (!matches.length) return null
  const totalShares = matches.reduce((s, p) => s + (p.shares || 0), 0)
  const totalCost = matches.reduce((s, p) => s + (p.price || 0) * (p.shares || 0), 0)
  return {
    avgPrice: totalShares > 0 ? totalCost / totalShares : matches[0].price,
    shares: totalShares,
  }
}

function readLocalPositions() {
  try {
    return JSON.parse(localStorage.getItem('predictflow_positions') || '[]')
  } catch {
    return []
  }
}

// Fallback: derive portfolio from localStorage positions when wallet scan has no matches.
// Keeps the UI usable in demo/mock mode and when markets don't yet publish real mints.
function buildPositionsFromLocal(localPositions) {
  return localPositions
    .filter(p => p.status === 'filled')
    .map(p => ({
      source: 'local',
      mint: null,
      marketId: p.marketId,
      question: p.question,
      eventTitle: p.eventTitle,
      category: p.category,
      side: p.side,
      shares: p.shares || 0,
      entryPrice: p.price || 0,
      currentPrice: p.price || 0,
      closeTime: p.closeTime || null,
      value: (p.price || 0) * (p.shares || 0),
      pnl: 0,
    }))
}

export function usePortfolio() {
  const { address, connected } = useWallet()
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [source, setSource] = useState('wallet')

  const load = useCallback(async () => {
    if (!connected || !address) {
      setPositions([])
      setSource('wallet')
      return
    }

    setLoading(true)
    setError(null)
    const localPositions = readLocalPositions()

    try {
      const [tokenAccounts, outcomeRaw] = await Promise.all([
        getTokenAccounts(address),
        fetchWithRetry(`${DFLOW_BASE}/api/v1/outcome_mints`).then(r => {
          if (!r.ok) throw new Error(`outcome_mints ${r.status}`)
          return r.json()
        }),
      ])

      const outcomeIndex = parseOutcomeMints(outcomeRaw)
      const held = tokenAccounts
        .map(acct => {
          const info = acct?.account?.data?.parsed?.info
          const mint = info?.mint
          const amount = parseFloat(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0)
          return mint && amount > 0 ? { mint, amount } : null
        })
        .filter(Boolean)
        .filter(t => outcomeIndex.has(t.mint))

      if (held.length === 0) {
        // No outcome tokens in wallet — fall back to localStorage positions
        setPositions(buildPositionsFromLocal(localPositions))
        setSource('local')
        return
      }

      const resolved = await Promise.all(held.map(async ({ mint, amount }) => {
        try {
          const res = await fetchWithRetry(`${DFLOW_BASE}/api/v1/market/by-mint/${encodeURIComponent(mint)}`)
          if (!res.ok) throw new Error(`by-mint ${res.status}`)
          const payload = await res.json()
          const m = normalizeMarket(payload, mint)
          if (!m) throw new Error('unparseable market')

          const entry = findLocalEntry(localPositions, m.marketId, m.side)
          const entryPrice = entry?.avgPrice ?? m.currentPrice
          const shares = entry?.shares ?? amount
          const value = m.currentPrice * shares
          const pnl = (m.currentPrice - entryPrice) * shares

          return {
            source: 'wallet',
            mint,
            marketId: m.marketId,
            question: m.question,
            eventTitle: m.eventTitle,
            category: m.category,
            side: m.side,
            shares,
            entryPrice,
            currentPrice: m.currentPrice,
            closeTime: m.closeTime,
            value,
            pnl,
          }
        } catch {
          return null
        }
      }))

      const clean = resolved.filter(Boolean)
      if (clean.length === 0) {
        setPositions(buildPositionsFromLocal(localPositions))
        setSource('local')
      } else {
        setPositions(clean)
        setSource('wallet')
      }
    } catch (err) {
      // Wallet RPC or outcome_mints unreachable — fall back to localStorage
      reportError(err, { context: 'usePortfolio' })
      setError(err.message || 'Portfolio fetch failed')
      setPositions(buildPositionsFromLocal(localPositions))
      setSource('local')
    } finally {
      setLoading(false)
    }
  }, [address, connected])

  useEffect(() => {
    load()
  }, [load])

  const totalValue = positions.reduce((s, p) => s + (p.value || 0), 0)
  const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0)

  return {
    positions,
    totalValue,
    totalPnl,
    count: positions.length,
    loading,
    error,
    source,
    refresh: load,
  }
}
