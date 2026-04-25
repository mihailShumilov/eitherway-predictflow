import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { logFeeEvent, getFeeLog, clearFeeLog, FEE_LOG_EVENT, summarizeFeeLog } from './feeLog'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('logFeeEvent', () => {
  it('appends to the log with a timestamp', () => {
    logFeeEvent({ tier: 'FREE', feeAmount: 0.3, platformAmount: 0.3 })
    const log = getFeeLog()
    expect(log).toHaveLength(1)
    expect(log[0].tier).toBe('FREE')
    expect(typeof log[0].timestamp).toBe('string')
  })

  it('dispatches the FEE_LOG_EVENT so same-tab listeners refresh', () => {
    const handler = vi.fn()
    window.addEventListener(FEE_LOG_EVENT, handler)
    logFeeEvent({ tier: 'PRO', feeAmount: 0.15 })
    expect(handler).toHaveBeenCalledTimes(1)
    window.removeEventListener(FEE_LOG_EVENT, handler)
  })

  it('caps the log at 1000 entries', () => {
    for (let i = 0; i < 1010; i++) {
      logFeeEvent({ tier: 'FREE', platformAmount: 0.001, marker: i })
    }
    const log = getFeeLog()
    expect(log.length).toBe(1000)
    // Oldest entries rolled off — first surviving marker should be 10.
    expect(log[0].marker).toBe(10)
  })
})

describe('clearFeeLog', () => {
  it('empties the log and emits the event', () => {
    logFeeEvent({ tier: 'FREE', platformAmount: 0.1 })
    const handler = vi.fn()
    window.addEventListener(FEE_LOG_EVENT, handler)
    clearFeeLog()
    expect(getFeeLog()).toHaveLength(0)
    expect(handler).toHaveBeenCalledTimes(1)
    window.removeEventListener(FEE_LOG_EVENT, handler)
  })
})

describe('summarizeFeeLog', () => {
  it('aggregates totals across platform + referral amounts', () => {
    const log = [
      { timestamp: new Date().toISOString(), platformAmount: 0.2, referralAmount: 0.05, tier: 'FREE' },
      { timestamp: new Date().toISOString(), platformAmount: 0.1, referralAmount: 0, tier: 'PRO' },
    ]
    const s = summarizeFeeLog(log)
    expect(s.total).toBeCloseTo(0.35, 6)
    expect(s.referralTotal).toBeCloseTo(0.05, 6)
    expect(s.trades).toBe(2)
    expect(s.tierCounts.FREE).toBe(1)
    expect(s.tierCounts.PRO).toBe(1)
  })
})
