import { describe, it, expect, beforeEach } from 'vitest'
import { getChartPalette, _resetPaletteCache } from './palette'

beforeEach(() => {
  _resetPaletteCache()
})

describe('getChartPalette', () => {
  it('returns all expected keys', () => {
    const p = getChartPalette()
    for (const k of ['bg', 'surface', 'card', 'border', 'text', 'muted', 'accent', 'green', 'red', 'yellow']) {
      expect(typeof p[k]).toBe('string')
      expect(p[k].length).toBeGreaterThan(0)
    }
  })

  it('caches the result', () => {
    const a = getChartPalette()
    const b = getChartPalette()
    expect(a).toBe(b)
  })

  it('picks up CSS vars when set on :root', () => {
    document.documentElement.style.setProperty('--terminal-green-hex', '#abcdef')
    _resetPaletteCache()
    const p = getChartPalette()
    expect(p.green).toBe('#abcdef')
    // Clean up so other tests don't inherit it.
    document.documentElement.style.removeProperty('--terminal-green-hex')
    _resetPaletteCache()
  })
})
