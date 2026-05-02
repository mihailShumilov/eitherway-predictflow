// Map raw upstream error strings to a stable enum stored in
// orders.failure_reason. Two reasons:
//   1. We persist the column and serve it back via GET /orders, so it must
//      not leak request URLs, API keys, or stack frames from upstream
//      services.
//   2. Stable codes let alerting / dashboards group failures.
//
// The full raw error is logged to console.error (Worker tail) for ops; only
// the enum is persisted.

export type FailureCode =
  | 'dflow_unavailable'
  | 'dflow_rejected'
  | 'dflow_unreachable'
  | 'dflow_no_transaction'
  | 'compute_input_invalid'
  | 'executor_key_unavailable'
  | 'executor_underfunded'
  | 'nonce_unavailable'
  | 'tx_oversized'
  | 'tx_error'
  | 'rpc_error'
  | 'rpc_unreachable'
  | 'confirmation_timeout'
  | 'decrypt_failed'
  | 'ata_invalid'
  | 'delegate_mismatch'
  | 'delegation_insufficient'
  | 'wallet_injected_before_nonce'
  | 'unknown'

export function classifyDflowHttp(status: number): FailureCode {
  if (status >= 500) return 'dflow_unavailable'
  return 'dflow_rejected'
}

export function classifyRpcError(raw: string): FailureCode {
  const lc = raw.toLowerCase()
  if (lc.startsWith('rpc_unreachable')) return 'rpc_unreachable'
  if (lc.startsWith('tx_error')) return 'tx_error'
  return 'rpc_error'
}
