import { describe, it, expect, beforeEach } from 'vitest'
import {
  appendPosition, getPositions, safeGet, safeSet,
  subscribePositions, getPositionsVersion, runMigrations,
} from './storage'

describe('safeGet / safeSet', () => {
  it('round-trips JSON', () => {
    safeSet('k', { a: 1, b: [2, 3] })
    expect(safeGet('k')).toEqual({ a: 1, b: [2, 3] })
  })

  it('returns fallback on missing key', () => {
    expect(safeGet('nope', 42)).toBe(42)
  })

  it('returns fallback on invalid JSON', () => {
    localStorage.setItem('bad', '{not-json}')
    expect(safeGet('bad', 'x')).toBe('x')
  })
})

describe('appendPosition', () => {
  it('appends and serializes concurrent writers', async () => {
    await Promise.all([
      appendPosition({ id: 1, marketId: 'm', status: 'filled' }),
      appendPosition({ id: 2, marketId: 'm', status: 'filled' }),
      appendPosition({ id: 3, marketId: 'm', status: 'filled' }),
    ])
    const got = getPositions()
    expect(got).toHaveLength(3)
    expect(got.map(p => p.id).sort()).toEqual([1, 2, 3])
  })

  it('bumps positions version and notifies subscribers', async () => {
    const before = getPositionsVersion()
    let calls = 0
    const unsub = subscribePositions(() => { calls++ })
    await appendPosition({ id: 9, marketId: 'm', status: 'filled' })
    expect(getPositionsVersion()).toBe(before + 1)
    expect(calls).toBeGreaterThan(0)
    unsub()
  })
})

describe('runMigrations', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('upgrades legacy positions to have a status field', () => {
    localStorage.setItem('predictflow_positions', JSON.stringify([
      { id: 1, marketId: 'x' },
    ]))
    runMigrations()
    const fixed = JSON.parse(localStorage.getItem('predictflow_positions'))
    expect(fixed[0].status).toBe('filled')
  })

  it('is idempotent', () => {
    runMigrations()
    const before = localStorage.getItem('predictflow_storage_version')
    runMigrations()
    const after = localStorage.getItem('predictflow_storage_version')
    expect(after).toBe(before)
  })
})
