import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, act } from '@testing-library/react'
import { KycProvider, useKyc } from './useKyc'
import { WalletProvider } from './useWallet'

function harness(onCtx) {
  function Consumer() {
    const ctx = useKyc()
    onCtx(ctx)
    return null
  }
  return render(
    <WalletProvider>
      <KycProvider>
        <Consumer />
      </KycProvider>
    </WalletProvider>
  )
}

describe('useKyc', () => {
  it('starts unverified', () => {
    let ctx
    harness(c => { ctx = c })
    expect(ctx.status).toBe('unverified')
    expect(ctx.verified).toBe(false)
  })

  it('requireKyc opens modal when unverified', () => {
    let ctx
    harness(c => { ctx = c })
    let allowed
    act(() => { allowed = ctx.requireKyc() })
    expect(allowed).toBe(false)
    expect(ctx.showModal).toBe(true)
  })

  it('markVerified flips status and closes modal', () => {
    let ctx
    harness(c => { ctx = c })
    act(() => { ctx.markVerified() })
    expect(ctx.status).toBe('verified')
    expect(ctx.showModal).toBe(false)
    let allowed
    act(() => { allowed = ctx.requireKyc() })
    expect(allowed).toBe(true)
  })

  it('persists verified state to localStorage', () => {
    let ctx
    harness(c => { ctx = c })
    act(() => { ctx.markVerified() })
    const saved = JSON.parse(localStorage.getItem('predictflow_kyc_status'))
    expect(saved.status).toBe('verified')
  })

  it('works without WalletProvider', () => {
    let ctx
    function Consumer() {
      ctx = useKyc()
      return null
    }
    expect(() =>
      render(
        <KycProvider>
          <Consumer />
        </KycProvider>
      )
    ).not.toThrow()
    expect(ctx.status).toBe('unverified')
  })
})
