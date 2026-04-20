import React, { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { mockEvents, mockCategories, flattenMarkets } from '../data/mockMarkets'

const MarketsContext = createContext(null)

const DFLOW_BASE = '/api/dflow'
const CACHE_KEY = 'predictflow_markets_cache'
const CACHE_TTL = 60000

function getCachedData() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null
    return parsed.data
  } catch {
    return null
  }
}

function setCachedData(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }))
  } catch {
    // localStorage full or unavailable
  }
}

export function MarketsProvider({ children }) {
  const [events, setEvents] = useState([])
  const [markets, setMarkets] = useState([])
  const [categories, setCategories] = useState(mockCategories)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [usingMockData, setUsingMockData] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('All')
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
      const [eventsRes, catsRes] = await Promise.all([
        fetch(`${DFLOW_BASE}/api/v1/events?status=active&withNestedMarkets=true`),
        fetch(`${DFLOW_BASE}/api/v1/tags_by_categories`),
      ])

      if (!eventsRes.ok) throw new Error(`Events API: ${eventsRes.status}`)

      const eventsData = await eventsRes.json()
      const rawEvents = Array.isArray(eventsData) ? eventsData : (eventsData.data || eventsData.events || [])

      const normalizedEvents = rawEvents.map((evt, i) => ({
        id: evt.id || `live-${i}`,
        ticker: evt.ticker || evt.eventTicker || evt.event_ticker || evt.slug || evt.id || `live-${i}`,
        title: evt.title || evt.name || evt.question || 'Untitled Event',
        category: evt.category || evt.tags?.[0] || 'Other',
        subcategory: evt.subcategory || evt.tags?.[1] || '',
        status: evt.status || 'active',
        closeTime: evt.closeTime || evt.close_time || evt.endDate || new Date(Date.now() + 86400000).toISOString(),
        markets: (evt.markets || []).map((m, j) => ({
          id: m.id || `live-mkt-${i}-${j}`,
          ticker: m.ticker || m.marketTicker || m.market_ticker || m.id || `live-mkt-${i}-${j}`,
          yesMint: m.yesMint || m.yes_mint || m.yesTokenMint || m.yes_token_mint || null,
          noMint: m.noMint || m.no_mint || m.noTokenMint || m.no_token_mint || null,
          question: m.question || m.title || m.name || evt.title || 'Market',
          yesAsk: parseFloat(m.yesAsk || m.yes_ask || m.yesPrice || 0.5),
          noAsk: parseFloat(m.noAsk || m.no_ask || m.noPrice || 0.5),
          yesBid: parseFloat(m.yesBid || m.yes_bid || m.yesAsk || 0.5),
          noBid: parseFloat(m.noBid || m.no_bid || m.noAsk || 0.5),
          volume: parseFloat(m.volume || 0),
          liquidity: parseFloat(m.liquidity || 0),
          status: m.status || 'active',
        })),
      }))

      let catsData = mockCategories
      if (catsRes.ok) {
        try {
          const rawCats = await catsRes.json()
          if (rawCats && typeof rawCats === 'object' && !Array.isArray(rawCats)) {
            catsData = rawCats
          }
        } catch {
          // keep mock categories
        }
      }

      setEvents(normalizedEvents)
      setMarkets(flattenMarkets(normalizedEvents))
      setCategories(catsData)
      setUsingMockData(false)
      setCachedData({ events: normalizedEvents, categories: catsData, isMock: false })
    } catch (err) {
      console.warn('DFlow API unavailable, using mock data:', err.message)
      setEvents(mockEvents)
      setMarkets(flattenMarkets(mockEvents))
      setCategories(mockCategories)
      setUsingMockData(true)
      setError(err.message || 'Unable to reach DFlow')
      setCachedData({ events: mockEvents, categories: mockCategories, isMock: true })
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
      const filtered = mockEvents.filter(e =>
        e.title.toLowerCase().includes(query.toLowerCase()) ||
        e.markets.some(m => m.question.toLowerCase().includes(query.toLowerCase()))
      )
      setEvents(filtered)
      setMarkets(flattenMarkets(filtered))
      setUsingMockData(true)
    } finally {
      setLoading(false)
    }
  }, [fetchEvents])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  const filteredMarkets = markets
    .filter(m => {
      if (selectedCategory === 'All') return true
      return m.category === selectedCategory
    })
    .filter(m => {
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      return (
        m.eventTitle.toLowerCase().includes(q) ||
        m.question.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
      )
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'volume':
          return b.volume - a.volume
        case 'closeTime':
          return new Date(a.closeTime) - new Date(b.closeTime)
        case 'yesPrice':
          return b.yesAsk - a.yesAsk
        case 'noPrice':
          return b.noAsk - a.noAsk
        default:
          return 0
      }
    })

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
