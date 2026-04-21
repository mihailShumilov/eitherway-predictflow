// Frozen state enum maps. Using these instead of string literals catches
// typos at import time (Object property access throws on missing) and
// gives editors autocomplete.

export const KYC_STATUS = Object.freeze({
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
  VERIFIED: 'verified',
})

export const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  EXECUTING: 'executing',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
})

export const POSITION_STATUS = Object.freeze({
  FILLED: 'filled',
  SETTLED: 'settled',
})

export const DCA_STATUS = Object.freeze({
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
})

export const ORDER_TYPE = Object.freeze({
  MARKET: 'market',
  LIMIT: 'limit',
  STOP_LOSS: 'stop-loss',
  TAKE_PROFIT: 'take-profit',
  DCA: 'dca',
})

export const MARKET_SIDE = Object.freeze({
  YES: 'yes',
  NO: 'no',
})
