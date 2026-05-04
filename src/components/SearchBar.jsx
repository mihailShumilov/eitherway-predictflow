import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'
import { track } from '../lib/analytics'

export default function SearchBar() {
  const { searchQuery, searchMarkets, setSearchQuery } = useMarkets()
  const [localQuery, setLocalQuery] = useState(searchQuery)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    setLocalQuery(searchQuery)
  }, [searchQuery])

  const handleChange = useCallback((e) => {
    const val = e.target.value
    setLocalQuery(val)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (val.trim()) {
        setSearchQuery(val)
        track('market_searched', { query_length: val.trim().length, source: 'debounce' })
      } else {
        setSearchQuery('')
        searchMarkets('')
      }
    }, 300)
  }, [searchMarkets, setSearchQuery])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      searchMarkets(localQuery)
      if (localQuery.trim()) {
        track('market_searched', { query_length: localQuery.trim().length, source: 'enter' })
      }
    }
    if (e.key === 'Escape') {
      clear()
    }
  }

  const clear = () => {
    if (localQuery) track('market_search_cleared', {})
    setLocalQuery('')
    setSearchQuery('')
    searchMarkets('')
    inputRef.current?.focus()
  }

  return (
    <div className="relative group">
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-muted group-focus-within:text-terminal-accent transition-colors"
      />
      <input
        ref={inputRef}
        type="text"
        value={localQuery}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Search markets... (e.g., Bitcoin, Arsenal, Fed)"
        className="w-full pl-10 pr-10 py-2 bg-terminal-card border border-terminal-border rounded-lg text-sm text-terminal-text placeholder-terminal-muted focus:outline-none focus:border-terminal-accent focus:ring-1 focus:ring-terminal-accent/30 transition-all font-sans"
      />
      {localQuery && (
        <button
          onClick={clear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-terminal-muted hover:text-terminal-text transition-colors"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}
