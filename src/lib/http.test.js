import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchWithRetry, generateIdempotencyKey } from './http'

describe('generateIdempotencyKey', () => {
  it('produces unique keys using CSPRNG', () => {
    const a = generateIdempotencyKey('test')
    const b = generateIdempotencyKey('test')
    expect(a).not.toBe(b)
    expect(a.startsWith('test-')).toBe(true)
    // UUID v4 suffix
    expect(a.split('test-')[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('throws if crypto.randomUUID is unavailable', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => { throw new Error('x') })
    // Replace the whole property so the hook sees undefined
    const original = globalThis.crypto.randomUUID
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      expect(() => generateIdempotencyKey('x')).toThrow(/crypto.randomUUID/)
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true })
      spy.mockRestore()
    }
  })
})

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('returns on first success', async () => {
    fetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('http://x', {}, { retries: 2, backoffMs: 1 })
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 503 then succeeds', async () => {
    fetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('http://x', {}, { retries: 2, backoffMs: 1 })
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting retries on persistent 500', async () => {
    fetch.mockResolvedValue(new Response('', { status: 500 }))
    const res = await fetchWithRetry('http://x', {}, { retries: 1, backoffMs: 1 })
    expect(res.status).toBe(500)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries network errors and eventually throws', async () => {
    fetch.mockRejectedValue(new TypeError('Network down'))
    await expect(
      fetchWithRetry('http://x', {}, { retries: 1, backoffMs: 1 })
    ).rejects.toThrow('Network down')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
