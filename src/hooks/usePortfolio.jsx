import { useState, useEffect, useCallback } from 'react'
import { useWallet } from './useWallet'
import { DFLOW_PROXY_BASE, SPL_TOKEN_PROGRAM, SOLANA_RPC_ENDPOINTS } from '../config/env'
import { fetchWithRetry } from '../lib/http'
import { reportError } from '../lib/errorReporter'
import { normalizeMarket } from '../lib/normalize'
import { buildOnchainEntries } from '../lib/onchainEntries'
import { backfillPositionFields } from '../lib/storage'

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
        // Persisted by recordTradeOutcome — used by enrichLocalSettled to
        // resolve win/loss exactly. Older positions won't have these.
        ticker: p.ticker || null,
        eventTicker: p.eventTicker || null,
        seriesTicker: p.seriesTicker || null,
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

// Normalize titles for fuzzy comparison: lowercase, collapse whitespace,
// strip quotes and punctuation that varies between display and API
// payloads (e.g. "Michael" vs Michael).
function normTitle(s) {
  return (s || '').toString().toLowerCase().replace(/["'""''`]/g, '').replace(/\s+/g, ' ').trim()
}

function toMs(t) {
  if (t == null) return null
  const n = typeof t === 'number' ? t : parseFloat(t)
  if (!Number.isFinite(n)) return null
  return n < 1e12 ? n * 1000 : n
}

// Best-effort win/loss enrichment for local-fallback positions whose
// markets have already settled. Local entries don't store the outcome
// mint or market ticker, so we resolve via DFlow's search + series
// listing. Two-step lookup:
//   1. /search?q=<event title> → matching events (with seriesTicker)
//   2. /events?seriesTickers=<series>&withNestedMarkets=true → events
//      with embedded markets, including each market's `result` field
// Within the series response we find the specific market by title and
// closeTime proximity to the user's stored closeTime.
//
// Most filters on /markets and /events?eventTickers are silently ignored
// by DFlow, but seriesTickers IS honored — that's the leverage point.
//
// Returns a new array with `won` and `currentPrice` filled in for
// positions we could resolve; unresolved positions are returned unchanged.
async function enrichLocalSettled(positions, dflowBase) {
  const targets = positions.filter(p => p.settled && p.won === null && (p.eventTitle || p.question))
  if (targets.length === 0) return positions

  // Cache per (seriesTicker → flat array of markets) so multiple
  // positions in the same weekly/series only hit DFlow once.
  const seriesCache = new Map()
  // Cache search results by event title — the same eventTitle can back
  // many positions (e.g. several "What will Trump say this week?" rows).
  const searchCache = new Map()

  async function searchEvents(eventTitle) {
    const key = normTitle(eventTitle)
    if (searchCache.has(key)) return searchCache.get(key)
    let events = []
    try {
      const url = `${dflowBase}/api/v1/search?q=${encodeURIComponent(eventTitle)}`
      const res = await fetchWithRetry(url)
      if (res.ok) {
        const payload = await res.json()
        events = payload?.events || []
      }
    } catch {}
    searchCache.set(key, events)
    return events
  }

  async function fetchSeriesMarkets(seriesTicker) {
    if (seriesCache.has(seriesTicker)) return seriesCache.get(seriesTicker)
    const flat = []
    try {
      const url = `${dflowBase}/api/v1/events?seriesTickers=${encodeURIComponent(seriesTicker)}&withNestedMarkets=true&limit=200`
      const res = await fetchWithRetry(url)
      if (res.ok) {
        const payload = await res.json()
        for (const e of (payload?.events || [])) {
          for (const m of (e.markets || [])) {
            flat.push({ ...m, _eventTicker: e.ticker })
          }
        }
      }
    } catch {}
    seriesCache.set(seriesTicker, flat)
    return flat
  }

  // Resolve targets sequentially — the series cache gets reused across
  // iterations, so doing this in parallel would just multiply requests
  // for the same series before the cache lands.
  const resolved = new Map() // position object → 'yes' | 'no'
  // Collect ticker/series/subtitle metadata for positions we resolved by
  // search — we'll write these back to localStorage so subsequent loads
  // hit the ticker fast-path instead of re-searching.
  const backfills = []
  for (const p of targets) {
    try {
      // Fast path: positions written after the ticker-persistence change
      // carry ticker + seriesTicker, so we can skip the search step and
      // look up the market exactly. Eliminates the scalar-market ambiguity
      // (multiple markets sharing a title) entirely.
      if (p.ticker && p.seriesTicker) {
        const markets = await fetchSeriesMarkets(p.seriesTicker)
        const exact = markets.find(m => m.ticker === p.ticker)
        if (exact) {
          const result = (exact.result || '').toString().toLowerCase()
          if (result === 'yes' || result === 'no') resolved.set(p, result)
          continue
        }
      }

      const eventTitle = p.eventTitle || p.question || ''
      const events = await searchEvents(eventTitle)
      const eventTitleNorm = normTitle(eventTitle)
      // Prefer events whose title matches; fall back to all events
      // matching the search if no exact title match is found.
      const candidates = events.filter(e => normTitle(e.title) === eventTitleNorm)
      const seriesTickers = Array.from(new Set(
        (candidates.length ? candidates : events).map(e => e.seriesTicker).filter(Boolean)
      ))
      if (seriesTickers.length === 0) continue

      const userCloseMs = toMs(p.closeTime)
      const questionNorm = normTitle(p.question)

      let pick = null
      for (const seriesTicker of seriesTickers) {
        const markets = await fetchSeriesMarkets(seriesTicker)
        const matches = markets.filter(m => normTitle(m.title) === questionNorm)
        if (matches.length === 0) continue

        // Disambiguate by closeTime — weekly series reuse the same title
        // across recurrences, so the right market is the one whose close
        // matches what the user stored at trade time.
        if (matches.length === 1) {
          pick = matches[0]
          break
        }
        if (userCloseMs == null) {
          // Multiple matches and no anchor to pick between them — bail
          // rather than guess. Common for scalar markets (Rotten Tomatoes,
          // sports score thresholds) where many markets share both title
          // AND closeTime, and the user's local entry doesn't carry the
          // subtitle that disambiguates them.
          continue
        }
        // Need a closeTime gap that's clearly smaller than the gap to
        // any sibling — otherwise we're guessing. Require the second-best
        // candidate to be at least 10 minutes further away than the best.
        const ranked = matches
          .map(m => ({ m, delta: Math.abs((toMs(m.closeTime) ?? Infinity) - userCloseMs) }))
          .filter(x => Number.isFinite(x.delta))
          .sort((a, b) => a.delta - b.delta)
        if (ranked.length === 0) continue
        if (ranked.length >= 2 && (ranked[1].delta - ranked[0].delta) < 10 * 60 * 1000) {
          // Ambiguous — multiple markets equidistant from user's stored
          // closeTime. Leave unresolved (UI will keep the gray "Settled"
          // badge) rather than misreport a win/loss.
          continue
        }
        pick = ranked[0].m
        if (pick) break
      }

      if (pick) {
        const result = (pick.result || '').toString().toLowerCase()
        if (result === 'yes' || result === 'no') {
          resolved.set(p, result)
          // Backfill ticker fields onto the matching localStorage entry
          // so the next portfolio load uses the ticker fast-path.
          if (!p.ticker) {
            backfills.push({
              match: {
                question: p.question,
                closeTime: p.closeTime,
                side: p.side,
                price: p.entryPrice,
                shares: p.shares,
              },
              fields: {
                ticker: pick.ticker || null,
                eventTicker: pick._eventTicker || null,
                seriesTicker: seriesTickers[0] || null,
                subtitle: pick.subtitle || null,
                yesSubTitle: pick.yesSubTitle || null,
                noSubTitle: pick.noSubTitle || null,
              },
            })
          }
        }
      }
    } catch {
      // best-effort: ignore and leave won=null
    }
  }

  // Fire-and-forget backfill — the lock inside backfillPositionFields
  // serializes against any concurrent appendPosition call.
  if (backfills.length > 0) {
    Promise.resolve(backfillPositionFields(backfills)).catch(() => {})
  }

  if (resolved.size === 0) return positions

  return positions.map(p => {
    const wonSide = resolved.get(p)
    if (!wonSide) return p
    const won = wonSide === p.side
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
