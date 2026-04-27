// Centralized timing constants. Magic numbers previously duplicated across
// priceWatcher.ts and submitter.ts; collected here so changes touch one
// place and the values can be referenced by tests.

// PriceWatcher reconnect / heartbeat
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 60_000
export const ALARM_REEVAL_MS = 30_000

// Submitter reaper threshold — Workers have ~30s wall-time; submission
// can poll up to 60s; rows older than this since last update get rolled
// from `submitting` back to `armed` for retry.
export const SUBMITTING_REAP_MS = 90_000

// Confirmation polling
export const CONFIRMATION_POLL_MS = 1_500
export const CONFIRMATION_MAX_MS = 60_000

// Hard timeout for confirmation polling — if a broadcast tx is still
// neither confirmed nor errored after this long, treat it as dropped.
// Common cause: durable-nonce mismatch where the runtime rejects the tx
// before inclusion in any block, leaving Helius's getSignatureStatuses
// returning null forever. We give up and mark the order failed so the
// row stops polling and the UI reflects reality.
export const CONFIRMATION_GIVE_UP_MS = 120_000

// Solana tx packet hard cap is 1232 bytes; reject anything materially
// larger as obvious garbage.
export const SIGNED_TX_MAX_BYTES = 1500
export const SIGNED_TX_MIN_BYTES = 64
