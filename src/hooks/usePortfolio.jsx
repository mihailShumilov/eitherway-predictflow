import { useState, useEffect, useCallback } from 'react'
import { useWallet } from './useWallet'
import { DFLOW_PROXY_BASE, SPL_TOKEN_PROGRAM, SOLANA_RPC_ENDPOINTS } from '../config/env'
import { fetchWithRetry } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { normalizeMarket } from '../lib/normalize'
import { buildOnchainEntries } from '../lib/onchainEntries'

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

// Fallback: derive portfolio from localStorage positions when the wallet
// scan has no matches. Keeps the UI usable in demo/mock mode, when DFlow
// hasn't yet published outcome mints, or when the user traded against
// markets the outcome_mints registry doesn't carry.
//
// We mark past-closeTime positions as `settled: true` (with `won: null`)
// up front so the UI shows a "Settled" badge instead of a stale date —
// that's a strict improvement even when we can't determine the winner.
// `enrichLocalSettled` then fills in `won` for as many of those as it can
// resolve via DFlow's search API.
function buildPositionsFromLocal(localPositions) {
  const now = Date.now()
  return localPositions
    .filter(p => p.status === 'filled')
    .map(p => {
      const closeMs = p.closeTime ? new Date(p.closeTime).getTime() : NaN
      const settled = Number.isFinite(closeMs) && closeMs <= now
      return {
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
        settled,
        won: null,
        entrySource: 'local',
      }
    })
}

// Best-effort win/loss enrichment for local-fallback positions whose
// markets have already settled. We can't look these up by mint (local
// entries don't store one), so we fall back to DFlow's search endpoint
// and match on event title. Returns a new array with `won` and
// `currentPrice` filled in for positions we could resolve; positions we
// couldn't resolve are returned unchanged.
async function enrichLocalSettled(positions, dflowBase) {
  const targets = positions.filter(p => p.settled && p.won === null && (p.eventTitle || p.question))
  if (targets.length === 0) return positions

  // De-dupe queries by event/question — multiple positions on the same
  // market only need one search.
  const queryFor = p => (p.eventTitle || p.question || '').trim()
  const queries = Array.from(new Set(targets.map(queryFor))).filter(Boolean)

  const resolutions = new Map() // query → { wonSide, status }
  await Promise.all(queries.map(async (q) => {
    try {
      const url = `${dflowBase}/api/v1/search?q=${encodeURIComponent(q)}`
      const res = await fetchWithRetry(url)
      if (!res.ok) return
      const payload = await res.json()
      const events = payload?.events || payload?.data || []
      const event = events.find(e => (e.title || '').trim().toLowerCase() === q.toLowerCase()) || events[0]
      if (!event?.ticker) return

      // Pull the resolved markets under that event. /markets is the only
      // endpoint that consistently honors the eventTicker filter for our
      // proxy; status=finalized narrows to determined markets.
      const mUrl = `${dflowBase}/api/v1/markets?eventTicker=${encodeURIComponent(event.ticker)}&status=finalized&limit=50`
      const mRes = await fetchWithRetry(mUrl)
      if (!mRes.ok) return
      const mPayload = await mRes.json()
      const markets = mPayload?.markets || mPayload?.data || []
      // Most events have one market, but some (e.g. multi-outcome) have
      // several. Index by title so multi-position events still resolve.
      for (const m of markets) {
        const result = (m.result || '').toString().toLowerCase()
        const wonSide = result === 'yes' ? 'yes' : result === 'no' ? 'no' : null
        if (wonSide) {
          const key = (m.title || event.title || '').trim().toLowerCase()
          resolutions.set(key, { wonSide, status: m.status })
        }
      }
      // Also key by event title as a fallback for positions whose stored
      // question matches the event title rather than the market title.
      const eventKey = (event.title || '').trim().toLowerCase()
      if (!resolutions.has(eventKey) && markets.length === 1) {
        const m = markets[0]
        const result = (m.result || '').toString().toLowerCase()
        if (result === 'yes' || result === 'no') {
          resolutions.set(eventKey, { wonSide: result, status: m.status })
        }
      }
    } catch {
      // best-effort: a missing/failed lookup just leaves won=null
    }
  }))

  if (resolutions.size === 0) return positions

  return positions.map(p => {
    if (!p.settled || p.won !== null) return p
    const titleKey = (p.question || '').trim().toLowerCase()
    const eventKey = (p.eventTitle || '').trim().toLowerCase()
    const hit = resolutions.get(titleKey) || resolutions.get(eventKey)
    if (!hit) return p
    const won = hit.wonSide === p.side
    const perShare = won ? 1 : 0
    return {
      ...p,
      won,
      currentPrice: perShare,
      value: perShare * p.shares,
      pnl: (perShare - (p.entryPrice || 0)) * p.shares,
    }
  })
}

// Compute the realized payout per share for a position. For settled markets
// where we know who won, redeemable value is $1 if the user's side won and
// $0 otherwise. For unsettled markets we fall back to the live ask price as
// a mark-to-market proxy.
function payoutPerShare(market) {
  if (market.settled && market.wonSide) {
    return market.wonSide === market.side ? 1 : 0
  }
  return market.currentPrice
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
      const [tokenAccounts, outcomeRaw, onchainEntries] = await Promise.all([
        getTokenAccounts(address),
        fetchWithRetry(`${DFLOW_BASE}/api/v1/outcome_mints`).then(r => {
          if (!r.ok) throw new Error(`outcome_mints ${r.status}`)
          return r.json()
        }),
        // Best-effort: on-chain trade history gives us cost basis when local
        // entries are missing (different browser, cleared storage, etc.).
        // Returns an empty Map on failure rather than throwing — the
        // portfolio still renders, just without P&L for unmatched mints.
        buildOnchainEntries(address, DFLOW_BASE),
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
        const local = buildPositionsFromLocal(localPositions)
        setPositions(local)
        setSource('local')
        // Best-effort: resolve win/loss for past-closeTime positions in
        // the background. UI updates again when this completes.
        enrichLocalSettled(local, DFLOW_BASE).then(enriched => {
          if (enriched !== local) setPositions(enriched)
        })
        return
      }

      const resolved = await Promise.all(held.map(async ({ mint, amount }) => {
        try {
          const res = await fetchWithRetry(`${DFLOW_BASE}/api/v1/market/by-mint/${encodeURIComponent(mint)}`)
          if (!res.ok) throw new Error(`by-mint ${res.status}`)
          const payload = await res.json()
          const m = normalizeMarket(payload, mint)
          if (!m) throw new Error('unparseable market')

          // Entry-price priority: localStorage (most accurate, includes the
          // exact fill the user made in this session) → on-chain trade
          // reconstruction (works across sessions/devices) → unknown (null,
          // surfaced in the UI as "—" rather than a fake $0.00 P&L).
          const localEntry = findLocalEntry(localPositions, m.marketId, m.side)
          const onchainEntry = onchainEntries.get(mint)
          const entry = localEntry || onchainEntry || null
          const entrySource = localEntry ? 'local' : (onchainEntry ? 'onchain' : 'unknown')
          const entryPrice = entry?.avgPrice ?? null
          const shares = entry?.shares ?? amount

          const perShare = payoutPerShare(m)
          const value = perShare * shares
          const pnl = entryPrice != null ? (perShare - entryPrice) * shares : null
          const won = m.settled ? (m.wonSide ? m.wonSide === m.side : null) : null

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
            entrySource,
            currentPrice: perShare,
            closeTime: m.closeTime,
            settled: m.settled,
            won,
            value,
            pnl,
          }
        } catch {
          return null
        }
      }))

      const clean = resolved.filter(Boolean)
      if (clean.length === 0) {
        const local = buildPositionsFromLocal(localPositions)
        setPositions(local)
        setSource('local')
        enrichLocalSettled(local, DFLOW_BASE).then(enriched => {
          if (enriched !== local) setPositions(enriched)
        })
      } else {
        setPositions(clean)
        setSource('wallet')
      }
    } catch (err) {
      // Wallet RPC or outcome_mints unreachable — fall back to localStorage
      reportError(err, { context: 'usePortfolio' })
      setError(err.message || 'Portfolio fetch failed')
      const local = buildPositionsFromLocal(localPositions)
      setPositions(local)
      setSource('local')
      enrichLocalSettled(local, DFLOW_BASE).then(enriched => {
        if (enriched !== local) setPositions(enriched)
      })
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
