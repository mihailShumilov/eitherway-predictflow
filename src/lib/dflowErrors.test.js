import { describe, it, expect } from 'vitest'
import { classifyOrderResponse, isGateRejection } from './dflowErrors'

// Build a Response-shaped fake — we only need .status, .clone(), .text()
// since classifyOrderResponse calls clone()+text() under the hood.
function fakeResp(status, bodyJsonOrText) {
  const text = typeof bodyJsonOrText === 'string' ? bodyJsonOrText : JSON.stringify(bodyJsonOrText)
  return {
    status,
    clone() { return this },
    async text() { return text },
  }
}

describe('classifyOrderResponse', () => {
  it('treats 401 as kyc rejection', async () => {
    const out = await classifyOrderResponse(fakeResp(401, { message: 'Sign in' }))
    expect(out.kind).toBe('kyc')
    expect(isGateRejection(out)).toBe(true)
  })

  it('treats 451 as compliance rejection', async () => {
    const out = await classifyOrderResponse(fakeResp(451, { message: 'Geoblocked' }))
    expect(out.kind).toBe('compliance')
    expect(isGateRejection(out)).toBe(true)
  })

  it('detects route_not_found code in body and returns a friendly message', async () => {
    // Real DFlow shape: `{ msg: "Route not found", code: "route_not_found" }`.
    const out = await classifyOrderResponse(fakeResp(400, { msg: 'Route not found', code: 'route_not_found' }))
    expect(out.kind).toBe('no_route')
    expect(out.message.toLowerCase()).toContain('liquidity')
    expect(isGateRejection(out)).toBe(false)
  })

  it('detects keyword "Route not found" even when code is missing', async () => {
    const out = await classifyOrderResponse(fakeResp(400, { msg: 'Route not found' }))
    expect(out.kind).toBe('no_route')
  })

  it('falls through to "other" for unknown server errors', async () => {
    const out = await classifyOrderResponse(fakeResp(500, { message: 'Internal' }))
    expect(out.kind).toBe('other')
    expect(out.status).toBe(500)
    expect(out.message).toBe('Internal')
  })

  it('handles non-JSON bodies gracefully', async () => {
    const out = await classifyOrderResponse(fakeResp(502, '<html>bad gateway</html>'))
    expect(out.kind).toBe('other')
    expect(out.status).toBe(502)
  })
})
