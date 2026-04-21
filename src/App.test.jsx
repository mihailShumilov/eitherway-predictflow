import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Block network side-effects so App render stays pure.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  }))
  if (!globalThis.WebSocket) {
    // Minimal stub so LivePricesProvider can call `new WebSocket(url)` in jsdom.
    globalThis.WebSocket = class {
      constructor() { this.readyState = 0 }
      addEventListener() {}
      send() {}
      close() {}
    }
  }
})

describe('App smoke', () => {
  it('renders without throwing', async () => {
    const { default: App } = await import('./App')
    // Render inside a try so any async error is surfaced as a test failure
    // instead of a dangling rejection.
    expect(() => render(<App />)).not.toThrow()
  })
})
