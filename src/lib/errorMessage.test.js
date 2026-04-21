import { describe, it, expect } from 'vitest'
import { safeErrorMessage } from './errorMessage'

describe('safeErrorMessage', () => {
  it('extracts Error.message', () => {
    expect(safeErrorMessage(new Error('oops'))).toBe('oops')
  })

  it('returns fallback on null/undefined', () => {
    expect(safeErrorMessage(null)).toContain('Something went wrong')
    expect(safeErrorMessage(undefined, 'fb')).toBe('fb')
  })

  it('strips HTML and control chars', () => {
    expect(safeErrorMessage('<script>alert(1)</script>hello')).toBe('alert(1)hello')
    expect(safeErrorMessage('a\u0000b')).toBe('ab')
  })

  it('truncates very long messages', () => {
    const huge = 'x'.repeat(500)
    const out = safeErrorMessage(huge)
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out.endsWith('…')).toBe(true)
  })
})
