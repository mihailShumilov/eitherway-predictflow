// Canvas-side reader for the `--terminal-*-hex` CSS vars defined in index.css.
//
// Canvas-rendering charts need concrete color strings, not CSS tokens, so we
// pull hex values from the document root. Lookups are cached — the palette
// is document-lifecycle-constant in practice, and reading computed style on
// every draw was a measurable hotspot in rapid resize loops.
//
// Pass `document.documentElement` in a browser; jsdom in tests returns the
// defaults baked in below so chart rendering stays deterministic.

const DEFAULTS = {
  bg: '#080c16',
  surface: '#0f1423',
  card: '#141a2e',
  border: '#1e2740',
  text: '#e2e8f0',
  muted: '#64748b',
  accent: '#3b82f6',
  green: '#10b981',
  red: '#ef4444',
  yellow: '#f59e0b',
}

let cached = null

export function getChartPalette(root) {
  if (cached) return cached
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    cached = { ...DEFAULTS }
    return cached
  }
  const style = window.getComputedStyle(el)
  const pick = (key) => {
    const raw = style.getPropertyValue(`--terminal-${key}-hex`).trim()
    return raw || DEFAULTS[key]
  }
  cached = {
    bg: pick('bg'),
    surface: pick('surface'),
    card: pick('card'),
    border: pick('border'),
    text: pick('text'),
    muted: pick('muted'),
    accent: pick('accent'),
    green: pick('green'),
    red: pick('red'),
    yellow: pick('yellow'),
  }
  return cached
}

// Test hook: reset the cache so fixture theme changes take effect.
export function _resetPaletteCache() {
  cached = null
}
