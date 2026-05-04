import React from 'react'
import { LayoutGrid, Trophy, Landmark, Bitcoin, TrendingUp, ChevronRight } from 'lucide-react'
import { useMarkets } from '../hooks/useMarkets'
import { useRoute } from '../hooks/useRoute'
import { track } from '../lib/analytics'

const categoryIcons = {
  All: LayoutGrid,
  Sports: Trophy,
  Politics: Landmark,
  Crypto: Bitcoin,
  Economics: TrendingUp,
}

const categoryColors = {
  All: 'text-terminal-accent',
  Sports: 'text-terminal-green',
  Politics: 'text-terminal-cyan',
  Crypto: 'text-terminal-yellow',
  Economics: 'text-terminal-red',
}

export default function CategorySidebar() {
  const { categories, selectedCategory, selectedSubcategory, allMarkets } = useMarkets()
  const { navigate } = useRoute()

  const categoryList = ['All', ...Object.keys(categories).filter(c => c !== 'All')]

  const getCategoryCount = (cat) => {
    if (cat === 'All') return allMarkets.length
    return allMarkets.filter(m => m.category === cat).length
  }

  const goToCategory = (cat) => {
    track('category_selected', { category: cat })
    navigate({ category: cat })
  }
  const goToSubcategory = (sub) => {
    if (sub === selectedSubcategory) {
      track('subcategory_cleared', { category: selectedCategory, subcategory: sub })
      navigate({ category: selectedCategory })
    } else {
      track('subcategory_selected', { category: selectedCategory, subcategory: sub })
      navigate({ category: selectedCategory, subcategory: sub })
    }
  }

  return (
    <aside className="w-full lg:w-60 shrink-0">
      <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-terminal-border">
          <h2 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
            Categories
          </h2>
        </div>
        <nav className="p-2">
          {categoryList.map((cat) => {
            const Icon = categoryIcons[cat] || LayoutGrid
            const color = categoryColors[cat] || 'text-terminal-muted'
            const isActive = selectedCategory === cat
            const count = getCategoryCount(cat)

            return (
              <button
                key={cat}
                onClick={() => goToCategory(cat)}
                className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-all duration-150 group ${
                  isActive
                    ? 'bg-terminal-highlight text-white'
                    : 'text-terminal-muted hover:bg-terminal-card hover:text-terminal-text'
                }`}
              >
                <Icon size={16} className={isActive ? color : 'text-terminal-muted group-hover:' + color} />
                <span className="flex-1 text-left font-medium">{cat}</span>
                <span className={`font-mono text-xs ${isActive ? 'text-terminal-accent' : 'text-terminal-muted'}`}>
                  {count}
                </span>
                {isActive && <ChevronRight size={14} className="text-terminal-accent" />}
              </button>
            )
          })}
        </nav>

        <div className="px-4 py-3 border-t border-terminal-border">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-2">
            Subcategories
          </h3>
          {selectedCategory === 'All' ? (
            <p className="text-xs text-terminal-muted">Select a category</p>
          ) : categories[selectedCategory]?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {categories[selectedCategory].map((sub) => {
                const isActive = selectedSubcategory === sub
                return (
                  <button
                    key={sub}
                    type="button"
                    onClick={() => goToSubcategory(sub)}
                    className={`px-2 py-1 text-xs rounded border transition-all ${
                      isActive
                        ? 'bg-terminal-accent/15 border-terminal-accent/60 text-terminal-accent'
                        : 'bg-terminal-card border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-accent/50'
                    }`}
                  >
                    {sub}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-terminal-muted">No subcategories</p>
          )}
        </div>
      </div>

      <div className="mt-4 bg-terminal-surface border border-terminal-border rounded-lg p-4">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-3">
          Quick Stats
        </h3>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-terminal-muted">Total Markets</span>
            <span className="font-mono text-terminal-text">{allMarkets.length}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-terminal-muted">Total Volume</span>
            <span className="font-mono text-terminal-green">
              ${(allMarkets.reduce((s, m) => s + m.volume, 0) / 1000000).toFixed(1)}M
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-terminal-muted">Avg YES Price</span>
            <span className="font-mono text-terminal-text">
              {(allMarkets.reduce((s, m) => s + m.yesAsk, 0) / (allMarkets.length || 1)).toFixed(2)}¢
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
