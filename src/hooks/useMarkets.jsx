import React, { useState, useEffect, useCallback, useMemo, createContext, useContext } from 'react'
import { flattenMarkets } from '../data/flattenMarkets'
import { DFLOW_PROXY_BASE, SOLANA_NETWORK } from '../config/env'

// Mainnet must never serve synthetic data — fail loudly instead so users don't
// trade against fake prices. Mock fallback stays available on devnet/other.
const ALLOW_MOCK_FALLBACK = (SOLANA_NETWORK || '').toLowerCase() !== 'mainnet'
import { fetchWithRetry } from '../lib/http'
import { extractOutcomeMints } from '../lib/normalize'
import { safeGet, safeSet } from '../lib/storage'
import { toCloseTimeIso } from '../lib/dateFormat'

// Lazy-loaded mock data. Only imported if the DFlow API fails — keeps
// ~460 lines of synthetic markets out of the happy-path bundle.
async function loadMocks() {
  const mod = await import('../data/mockMarkets')
  return { mockEvents: mod.mockEvents, mockCategories: mod.mockCategories }
}

const MarketsContext = createContext(null)

const DFLOW_BASE = DFLOW_PROXY_BASE
const CACHE_KEY = 'predictflow_markets_cache'
const CACHE_TTL = 60000

function getCachedData() {
  const parsed = safeGet(CACHE_KEY, null)
  if (!parsed?.timestamp || !parsed.data) return null
  if (Date.now() - parsed.timestamp > CACHE_TTL) return null
  // Don't serve mock-flagged cache on mainnet — could be left over from a
  // prior build that allowed fallback.
  if (!ALLOW_MOCK_FALLBACK && parsed.data.isMock) return null
  return parsed.data
}

function setCachedData(data) {
  safeSet(CACHE_KEY, { data, timestamp: Date.now() })
}

const DEFAULT_CATEGORIES = { All: [] }

export function MarketsProvider({ children }) {
  const [events, setEvents] = useState([])
  const [markets, setMarkets] = useState([])
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [usingMockData, setUsingMockData] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [selectedSubcategory, setSelectedSubcategory] = useState('')
  const [sortBy, setSortBy] = useState('volume')

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError(null)

    const cached = getCachedData()
    if (cached) {
      setEvents(cached.events)
      setMarkets(flattenMarkets(cached.events))
      if (cached.categories) setCategories(cached.categories)
      setUsingMockData(cached.isMock || false)
      setLoading(false)
      return
    }

    try {
      const [eventsRes, catsRes, seriesCatsRes] = await Promise.all([
        fetchWithRetry(`${DFLOW_BASE}/api/v1/events?status=active&withNestedMarkets=true`),
        fetchWithRetry(`${DFLOW_BASE}/api/v1/tags_by_categories`),
        fetch('/api/dflow-series-categories').catch(() => null),
      ])

      if (!eventsRes.ok) throw new Error(`Events API: ${eventsRes.status}`)

      // DFlow events lack category metadata; join through seriesTicker against
      // the slim lookup served by /api/dflow-series-categories. Lookup shape:
      // { TICKER: ["Category", "tag1", "tag2", ...] }. Missing or unmapped
      // tickers fall back to 'Other' / no tags.
      let seriesLookup = {}
      if (seriesCatsRes && seriesCatsRes.ok) {
        try {
          const parsed = await seriesCatsRes.json()
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            seriesLookup = parsed
          }
        } catch {
          // keep empty
        }
      }

      const eventsData = await eventsRes.json()
      const rawEvents = Array.isArray(eventsData) ? eventsData : (eventsData.data || eventsData.events || [])

      const normalizedEvents = rawEvents.map((evt, i) => {
        const seriesTicker = evt.seriesTicker || evt.series_ticker
        const seriesEntry = (seriesTicker && Array.isArray(seriesLookup[seriesTicker]))
          ? seriesLookup[seriesTicker]
          : null
        const seriesCategory = seriesEntry ? seriesEntry[0] : undefined
        const seriesTags = seriesEntry ? seriesEntry.slice(1) : []
        const tags = Array.isArray(evt.tags) && evt.tags.length ? evt.tags : seriesTags
        return {
        id: evt.id || `live-${i}`,
        ticker: evt.ticker || evt.eventTicker || evt.event_ticker || evt.slug || evt.id || `live-${i}`,
        title: evt.title || evt.name || evt.question || 'Untitled Event',
        category: evt.category || seriesCategory || tags[0] || 'Other',
        subcategory: evt.subcategory || tags[0] || '',
        tags,
        status: evt.status || 'active',
        // DFlow events don't carry a close time — it lives on each nested
        // market. Read the event-level fields defensively in case that ever
        // changes; otherwise null and let flattenMarkets pick up the per-
        // market value below.
        closeTime: toCloseTimeIso(evt.closeTime ?? evt.close_time ?? evt.endDate),
        markets: (evt.markets || []).map((m, j) => ({
          id: m.id || `live-mkt-${i}-${j}`,
          ticker: m.ticker || m.marketTicker || m.market_ticker || m.id || `live-mkt-${i}-${j}`,
          ...extractOutcomeMints(m),
          question: m.question || m.title || m.name || evt.title || 'Market',
          subtitle: m.subtitle || '',
          yesSubTitle: m.yesSubTitle || m.yes_sub_title || '',
          noSubTitle: m.noSubTitle || m.no_sub_title || '',
          yesAsk: parseFloat(m.yesAsk || m.yes_ask || m.yesPrice || 0.5),
          noAsk: parseFloat(m.noAsk || m.no_ask || m.noPrice || 0.5),
          yesBid: parseFloat(m.yesBid || m.yes_bid || m.yesAsk || 0.5),
          noBid: parseFloat(m.noBid || m.no_bid || m.noAsk || 0.5),
          volume: parseFloat(m.volume || 0),
          liquidity: parseFloat(m.liquidity || 0),
          status: m.status || 'active',
          closeTime: toCloseTimeIso(m.closeTime ?? m.close_time),
        })),
        }
      })

      let catsData = DEFAULT_CATEGORIES
      if (catsRes.ok) {
        try {
          const rawCats = await catsRes.json()
          // DFlow shape: { tagsByCategories: { Sports: [...], Social: null, ... } }
          // Unwrap the envelope and coerce null subcategory lists to [].
          const inner = rawCats && typeof rawCats === 'object' && !Array.isArray(rawCats)
            ? (rawCats.tagsByCategories ?? rawCats)
            : null
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            catsData = Object.fromEntries(
              Object.entries(inner).map(([k, v]) => [k, Array.isArray(v) ? v : []])
            )
          }
        } catch {
          // keep default
        }
      }

      setEvents(normalizedEvents)
      setMarkets(flattenMarkets(normalizedEvents))
      setCategories(catsData)
      setUsingMockData(false)
      setCachedData({ events: normalizedEvents, categories: catsData, isMock: false })
    } catch (err) {
      setError(err.message || 'Unable to reach DFlow')
      if (ALLOW_MOCK_FALLBACK) {
        const { mockEvents, mockCategories } = await loadMocks()
        setEvents(mockEvents)
        setMarkets(flattenMarkets(mockEvents))
        setCategories(mockCategories)
        setUsingMockData(true)
        setCachedData({ events: mockEvents, categories: mockCategories, isMock: true })
      } else {
        setEvents([])
        setMarkets([])
        setCategories(DEFAULT_CATEGORIES)
        setUsingMockData(false)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const searchMarkets = useCallback(async (query) => {
    setSearchQuery(query)
    if (!query.trim()) {
      fetchEvents()
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`${DFLOW_BASE}/api/v1/search?query=${encodeURIComponent(query)}`)
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      const results = Array.isArray(data) ? data : (data.data || data.results || [])
      if (results.length > 0) {
        setEvents(results)
        setMarkets(flattenMarkets(results))
        setUsingMockData(false)
      } else {
        throw new Error('No results from API')
      }
    } catch {
      if (ALLOW_MOCK_FALLBACK) {
        const { mockEvents } = await loadMocks()
        const filtered = mockEvents.filter(e =>
          e.title.toLowerCase().includes(query.toLowerCase()) ||
          e.markets.some(m => m.question.toLowerCase().includes(query.toLowerCase()))
        )
        setEvents(filtered)
        setMarkets(flattenMarkets(filtered))
        setUsingMockData(true)
      } else {
        setEvents([])
        setMarkets([])
        setUsingMockData(false)
      }
    } finally {
      setLoading(false)
    }
  }, [fetchEvents])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  // Memoize — this runs on every provider render and every consumer would
  // otherwise get a new array identity, defeating React.memo downstream.
  const filteredMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return markets
      .filter(m => selectedCategory === 'All' || m.category === selectedCategory)
      .filter(m => !selectedSubcategory || (m.tags || []).includes(selectedSubcategory))
      .filter(m => {
        if (!q) return true
        return (
          m.eventTitle.toLowerCase().includes(q) ||
          m.question.toLowerCase().includes(q) ||
          m.category.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'volume': return b.volume - a.volume
          case 'closeTime': {
            const now = Date.now()
            const aMs = new Date(a.closeTime).getTime()
            const bMs = new Date(b.closeTime).getTime()
            const aClosed = Number.isFinite(aMs) && aMs <= now
            const bClosed = Number.isFinite(bMs) && bMs <= now
            if (aClosed !== bClosed) return aClosed ? 1 : -1
            return aClosed ? bMs - aMs : aMs - bMs
          }
          case 'yesPrice': return b.yesAsk - a.yesAsk
          case 'noPrice': return b.noAsk - a.noAsk
          default: return 0
        }
      })
  }, [markets, selectedCategory, selectedSubcategory, searchQuery, sortBy])

  return (
    <MarketsContext.Provider value={{
      events,
      markets: filteredMarkets,
      allMarkets: markets,
      categories,
      loading,
      error,
      usingMockData,
      searchQuery,
      setSearchQuery,
      searchMarkets,
      selectedCategory,
      setSelectedCategory,
      selectedSubcategory,
      setSelectedSubcategory,
      sortBy,
      setSortBy,
      refresh: fetchEvents,
    }}>
      {children}
    </MarketsContext.Provider>
  )
}

export function useMarkets() {
  const ctx = useContext(MarketsContext)
  if (!ctx) throw new Error('useMarkets must be used within MarketsProvider')
  return ctx
}
