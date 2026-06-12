import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../config/fees', () => ({
  FEE_CONFIG: { FEE_WALLET: 'Fee1111111111111111111111111111111111111111' },
  isFeeWalletConfigured: () => true,
}))

vi.mock('./feeTransfer', () => ({
  buildFeeTransferTransaction: vi.fn(),
  sendRawTransaction: vi.fn(),
}))

import { sweepFee } from './feeSweep'
import { buildFeeTransferTransaction, sendRawTransaction } from './feeTransfer'

const feeCalc = { platformAmount: 0.3, referralAmount: 0 }

function makeBuilt() {
  return { tx: { id: 'tx' }, summary: [] }
}

describe('sweepFee broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFeeTransferTransaction.mockResolvedValue(makeBuilt())
  })

  it('uses signAndSendTransaction when the wallet supports it', async () => {
    const provider = {
      signAndSendTransaction: vi.fn().mockResolvedValue({ signature: 'sig-direct' }),
    }
    const activeWallet = { getProvider: () => provider }
    const out = await sweepFee({ address: 'Own1111111111111111111111111111111111111111', activeWallet, feeCalc, referrer: null })
    expect(provider.signAndSendTransaction).toHaveBeenCalledTimes(1)
    expect(sendRawTransaction).not.toHaveBeenCalled()
    expect(out).toEqual({ signature: 'sig-direct' })
  })

  it('broadcasts the signed bytes for signTransaction-only wallets', async () => {
    const serialized = new Uint8Array([1, 2, 3])
    const signed = { serialize: () => serialized }
    const provider = {
      // No signAndSendTransaction — sign-only wallet (e.g. some Solflare builds).
      signTransaction: vi.fn().mockResolvedValue(signed),
    }
    sendRawTransaction.mockResolvedValue('sig-broadcast')
    const activeWallet = { getProvider: () => provider }
    const out = await sweepFee({ address: 'Own1111111111111111111111111111111111111111', activeWallet, feeCalc, referrer: null })
    expect(provider.signTransaction).toHaveBeenCalledTimes(1)
    // The signed transaction must actually be submitted, not dropped.
    expect(sendRawTransaction).toHaveBeenCalledWith(serialized)
    expect(out).toBe('sig-broadcast')
  })

  it('propagates broadcast failures so the caller records the sweep as failed', async () => {
    const provider = {
      signTransaction: vi.fn().mockResolvedValue({ serialize: () => new Uint8Array([9]) }),
    }
    sendRawTransaction.mockRejectedValue(new Error('All RPC endpoints failed'))
    const activeWallet = { getProvider: () => provider }
    await expect(
      sweepFee({ address: 'Own1111111111111111111111111111111111111111', activeWallet, feeCalc, referrer: null }),
    ).rejects.toThrow(/RPC/)
  })
})
