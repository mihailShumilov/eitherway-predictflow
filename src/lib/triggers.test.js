import { describe, it, expect } from 'vitest'
import { shouldTriggerOrder } from './triggers'

const base = { status: 'pending', side: 'yes', triggerPrice: 0.4 }

describe('shouldTriggerOrder', () => {
  it('limit fires when price <= trigger', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'limit' }, 0.39)).toBe(true)
    expect(shouldTriggerOrder({ ...base, orderType: 'limit' }, 0.40)).toBe(true)
    expect(shouldTriggerOrder({ ...base, orderType: 'limit' }, 0.41)).toBe(false)
  })

  it('stop-loss fires when price <= trigger', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'stop-loss' }, 0.30)).toBe(true)
    expect(shouldTriggerOrder({ ...base, orderType: 'stop-loss' }, 0.45)).toBe(false)
  })

  it('take-profit fires when price >= trigger', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'take-profit', triggerPrice: 0.7 }, 0.7)).toBe(true)
    expect(shouldTriggerOrder({ ...base, orderType: 'take-profit', triggerPrice: 0.7 }, 0.71)).toBe(true)
    expect(shouldTriggerOrder({ ...base, orderType: 'take-profit', triggerPrice: 0.7 }, 0.69)).toBe(false)
  })

  it('does not fire when order is not pending or armed', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'limit', status: 'filled' }, 0.1)).toBe(false)
    expect(shouldTriggerOrder({ ...base, orderType: 'limit', status: 'cancelled' }, 0.1)).toBe(false)
  })

  it('fires on armed status (re-evaluation after transient submit failure)', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'limit', status: 'armed' }, 0.39)).toBe(true)
  })

  it('returns false on null inputs', () => {
    expect(shouldTriggerOrder(null, 0.5)).toBe(false)
    expect(shouldTriggerOrder({ ...base, orderType: 'limit' }, null)).toBe(false)
  })

  it('returns false on unknown orderType', () => {
    expect(shouldTriggerOrder({ ...base, orderType: 'weird' }, 0.5)).toBe(false)
  })
})
