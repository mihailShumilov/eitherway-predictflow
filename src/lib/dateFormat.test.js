import { describe, it, expect } from 'vitest'
import { formatMarketClose, formatMarketCloseFull, getTzLabel } from './dateFormat'

describe('date formatting', () => {
  it('formatMarketClose returns — for falsy input', () => {
    expect(formatMarketClose(null)).toBe('—')
    expect(formatMarketClose('')).toBe('—')
  })

  it('formatMarketClose includes month, time, and a timezone label', () => {
    const iso = '2026-06-01T15:30:00Z'
    const out = formatMarketClose(iso)
    // Structure: "<Mon> <D>, <HH>:<MM> <TZ>"
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} .+$/)
    // Timezone label is whatever the runner's zone is — just assert non-empty.
    expect(out.split(' ').pop().length).toBeGreaterThan(1)
  })

  it('formatMarketCloseFull includes the year', () => {
    const out = formatMarketCloseFull('2026-06-01T15:30:00Z')
    expect(out).toMatch(/2026/)
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} .+$/)
  })

  it('getTzLabel returns a non-empty string', () => {
    expect(getTzLabel(new Date()).length).toBeGreaterThan(0)
  })
})
