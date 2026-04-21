import { describe, it, expect } from 'vitest'
import { maskWallet, hashWallet } from './privacy'

describe('maskWallet', () => {
  it('masks long addresses', () => {
    expect(maskWallet('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('EPjF…Dt1v')
  })
  it('preserves short inputs unchanged', () => {
    expect(maskWallet('short')).toBe('short')
    expect(maskWallet(null)).toBe(null)
  })
})

describe('hashWallet', () => {
  it('produces a stable, prefixed hash', async () => {
    const a = await hashWallet('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    const b = await hashWallet('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(a).toBe(b)
    expect(a.startsWith('wallet-')).toBe(true)
  })
  it('differs for different inputs', async () => {
    const a = await hashWallet('aaaa')
    const b = await hashWallet('bbbb')
    expect(a).not.toBe(b)
  })
})
