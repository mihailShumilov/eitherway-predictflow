import { describe, it, expect } from 'vitest'
import { shouldTriggerOrder, pricesFromMessage, priceForOrder } from './triggers'

describe('shouldTriggerOrder', () => {
  it('limit BUY YES fires when ask drops to or below trigger', () => {
    const o = { orderType: 'limit' as const, triggerPrice: 0.5, status: 'pending' }
    expect(shouldTriggerOrder(o, 0.6)).toBe(false)
    expect(shouldTriggerOrder(o, 0.5)).toBe(true)
    expect(shouldTriggerOrder(o, 0.4)).toBe(true)
  })
  it('take-profit fires when bid reaches or exceeds trigger', () => {
    const o = { orderType: 'take-profit' as const, triggerPrice: 0.7, status: 'pending' }
    expect(shouldTriggerOrder(o, 0.6)).toBe(false)
    expect(shouldTriggerOrder(o, 0.7)).toBe(true)
    expect(shouldTriggerOrder(o, 0.8)).toBe(true)
  })
  it('does not fire on non-pending/non-armed status', () => {
    const o = { orderType: 'limit' as const, triggerPrice: 0.5, status: 'cancelled' }
    expect(shouldTriggerOrder(o, 0.4)).toBe(false)
  })
  it('fires on armed status (re-evaluation after a transient submit failure)', () => {
    const o = { orderType: 'limit' as const, triggerPrice: 0.5, status: 'armed' }
    expect(shouldTriggerOrder(o, 0.4)).toBe(true)
  })
})

describe('pricesFromMessage', () => {
  it('returns full quad when all four sides are quoted', () => {
    const out = pricesFromMessage({ yes_ask: '0.42', yes_bid: '0.40', no_ask: '0.60', no_bid: '0.58' })
    expect(out).toEqual({ yesAsk: 0.42, yesBid: 0.40, noAsk: 0.60, noBid: 0.58 })
  })
  it('synthesizes a missing side from the inverse', () => {
    // Only NO bid quoted → YES ask = 1 - NO bid
    const out = pricesFromMessage({ yes_ask: null, yes_bid: null, no_ask: null, no_bid: '0.58' })
    expect(out?.yesAsk).toBeCloseTo(0.42, 5)
    expect(out?.yesBid).toBeNull()
  })
  it('returns null on a fully empty book', () => {
    expect(pricesFromMessage({ yes_ask: null, yes_bid: null, no_ask: null, no_bid: null })).toBeNull()
  })
})

describe('priceForOrder', () => {
  const prices = { yesAsk: 0.42, yesBid: 0.40, noAsk: 0.60, noBid: 0.58 }

  it('limit BUY YES uses YES ask', () => {
    expect(priceForOrder(prices, 'yes', 'limit')).toBe(0.42)
  })
  it('limit BUY NO uses NO ask', () => {
    expect(priceForOrder(prices, 'no', 'limit')).toBe(0.60)
  })
  it('stop-loss SELL YES uses YES bid', () => {
    expect(priceForOrder(prices, 'yes', 'stop-loss')).toBe(0.40)
  })
  it('take-profit SELL YES uses YES bid', () => {
    expect(priceForOrder(prices, 'yes', 'take-profit')).toBe(0.40)
  })
  it('returns null when the relevant side is empty', () => {
    expect(priceForOrder({ ...prices, yesAsk: null }, 'yes', 'limit')).toBeNull()
    expect(priceForOrder({ ...prices, yesBid: null }, 'yes', 'stop-loss')).toBeNull()
  })
})
