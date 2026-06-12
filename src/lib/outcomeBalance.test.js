import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture every token-account address queried, and stub balances per ATA.
const queried = []
let balances = {}

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal()
  class MockConnection {
    constructor(url) {
      this.url = url
    }
    async getTokenAccountBalance(ata) {
      const key = ata.toBase58()
      queried.push(key)
      const v = balances[key]
      if (v === undefined) {
        throw new Error('failed to get token account balance: could not find account')
      }
      return { value: { uiAmountString: v } }
    }
  }
  return { ...actual, Connection: MockConnection }
})

import { getOutcomeBalance } from './outcomeBalance'
import { PublicKey } from '@solana/web3.js'

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// Sentinel ATA addresses returned by the stubbed PDA derivation, so the test
// can assert which token program the code derived against without relying on
// findProgramAddressSync (its on-curve check is broken under jsdom).
const TOKEN_2022_ATA = 'So11111111111111111111111111111111111111112'
const CLASSIC_ATA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function buffersEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('getOutcomeBalance', () => {
  const owner = 'So11111111111111111111111111111111111111112'
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

  beforeEach(() => {
    queried.length = 0
    balances = {}
    const t2022Buf = TOKEN_2022_PROGRAM_ID.toBuffer()
    // outcomeBalance derives with seeds [owner, tokenProgram, mint]; map the
    // token-program seed to a distinct sentinel ATA per program.
    vi.spyOn(PublicKey, 'findProgramAddressSync').mockImplementation((seeds) => {
      const isToken2022 = buffersEqual(seeds[1], t2022Buf)
      return [new PublicKey(isToken2022 ? TOKEN_2022_ATA : CLASSIC_ATA), 255]
    })
  })

  it('reads the Token-2022 ATA first and returns its balance', async () => {
    balances[TOKEN_2022_ATA] = '25.5'
    const bal = await getOutcomeBalance({ rpcUrl: 'http://rpc', owner, mint })
    expect(bal).toBe(25.5)
    // Token-2022 ATA must be the first (and only) address queried.
    expect(queried[0]).toBe(TOKEN_2022_ATA)
    expect(queried).toHaveLength(1)
  })

  it('falls back to the classic SPL ATA when Token-2022 is absent', async () => {
    balances[CLASSIC_ATA] = '10'
    const bal = await getOutcomeBalance({ rpcUrl: 'http://rpc', owner, mint })
    expect(bal).toBe(10)
    expect(queried).toEqual([TOKEN_2022_ATA, CLASSIC_ATA])
  })

  it('returns 0 when no token account exists under either program', async () => {
    const bal = await getOutcomeBalance({ rpcUrl: 'http://rpc', owner, mint })
    expect(bal).toBe(0)
    expect(queried).toEqual([TOKEN_2022_ATA, CLASSIC_ATA])
  })
})
