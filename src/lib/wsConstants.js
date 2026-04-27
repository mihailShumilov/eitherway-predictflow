// Shared timing constants for the frontend WebSocket client. Pulled out
// of dflowWs.js so they can be referenced (and overridden) by tests
// without poking at the singleton's module-level state.

// Exponential reconnect: starts at BASE, doubles per attempt, capped at
// MAX. We don't track total attempts beyond the cap; once the connection
// recovers, the counter resets to 0 inside the open handler.
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

// If no message has arrived in HEARTBEAT_TIMEOUT_MS the connection is
// considered silently dead — force-close it to trigger reconnect logic.
// Set higher than DFlow's typical inter-message gap on a quiet market.
export const HEARTBEAT_TIMEOUT_MS = 60_000
export const HEARTBEAT_CHECK_MS = 15_000
