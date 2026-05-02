import type { Env } from '../env'
import { bytesToBase64 } from './crypto'

export type SendResult =
  | { ok: true; signature: string }
  | { ok: false; permanent: boolean; error: string }

export type StatusResult = { confirmed: boolean; error?: string }

// Result of simulateTransaction. The discriminator distinguishes between
// transport failures (RPC unreachable / 5xx / malformed JSON) and a
// simulation that ran but reported tx-level errors. Both cases map to
// distinct FailureCode buckets in the caller.
export type SimulateResult =
  | {
      ok: true
      // Per-account post-simulation state, parallel to the addresses
      // passed in. base64-encoded; null for accounts that don't exist
      // at simulation time.
      accounts: Array<{ data: string; lamports: number; owner: string } | null>
      // null when the simulated tx executed successfully on-chain logic.
      // Non-null when the tx itself errored (e.g. instruction failed).
      err: unknown | null
      logs: string[]
      unitsConsumed: number | null
    }
  | { ok: false; permanent: boolean; error: string }

// -32602: invalid params (malformed tx)
// -32003: BlockhashNotFound — for durable nonce, stale nonce
// -32004: BlockNotAvailable
// -32005 NodeUnhealthy is transient — exclude from the permanent set.
const PERMANENT_RPC_CODES = new Set<number>([-32602, -32003, -32004])

export async function sendRawTransaction(env: Env, bytes: Uint8Array): Promise<SendResult> {
  const b64 = bytesToBase64(bytes)
  let res: Response
  try {
    res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        // maxRetries: 5 — Helius rebroadcasts up to 5 times if the leader
        // doesn't include the tx. Pairs with the priority fee embedded by
        // DFlow's /order so each rebroadcast has a higher chance of landing.
        // Durable nonces guarantee no double-spend across retries.
        params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }],
      }),
    })
  } catch (err) {
    return { ok: false, permanent: false, error: `rpc_unreachable: ${String(err)}` }
  }
  if (!res.ok) {
    return { ok: false, permanent: res.status >= 400 && res.status < 500, error: `rpc_${res.status}` }
  }
  let body: any
  try { body = await res.json() } catch { return { ok: false, permanent: false, error: 'rpc_bad_json' } }
  if (body.error) {
    const code = body.error.code
    const message = body.error.message ?? 'rpc_error'
    return {
      ok: false,
      permanent: PERMANENT_RPC_CODES.has(code),
      error: `${code}:${message}`.slice(0, 500),
    }
  }
  if (typeof body.result !== 'string') {
    return { ok: false, permanent: false, error: 'rpc_no_signature' }
  }
  return { ok: true, signature: body.result }
}

export async function getSignatureStatus(env: Env, signature: string): Promise<StatusResult> {
  try {
    const res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    })
    if (!res.ok) return { confirmed: false }
    const body: any = await res.json().catch(() => null)
    const status = body?.result?.value?.[0]
    if (!status) return { confirmed: false }
    if (status.err) {
      return { confirmed: false, error: `tx_error:${JSON.stringify(status.err).slice(0, 200)}` }
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { confirmed: true }
    }
    return { confirmed: false }
  } catch {
    return { confirmed: false }
  }
}

// Run simulateTransaction on a signed tx with a list of addresses to
// retrieve post-simulation account state for. Used as a pre-broadcast
// safety gate: lets the keeper inspect what the tx will actually do
// (token balance changes, errors) without committing it on-chain.
//
// `replaceRecentBlockhash: true` lets simulation run even when the tx's
// nonce-based recentBlockhash is older than the cluster's current state —
// safe here because we only care about the tx body's instructions, not
// blockhash freshness.
export async function simulateTransaction(
  env: Env,
  bytes: Uint8Array,
  addresses: string[],
): Promise<SimulateResult> {
  const b64 = bytesToBase64(bytes)
  let res: Response
  try {
    res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [b64, {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses },
        }],
      }),
    })
  } catch (err) {
    return { ok: false, permanent: false, error: `rpc_unreachable: ${String(err)}` }
  }
  if (!res.ok) {
    return { ok: false, permanent: res.status >= 400 && res.status < 500, error: `rpc_${res.status}` }
  }
  let body: any
  try { body = await res.json() } catch { return { ok: false, permanent: false, error: 'rpc_bad_json' } }
  if (body.error) {
    const code = body.error.code
    const message = body.error.message ?? 'rpc_error'
    return {
      ok: false,
      permanent: PERMANENT_RPC_CODES.has(code),
      error: `${code}:${message}`.slice(0, 500),
    }
  }
  const value = body?.result?.value
  if (!value) return { ok: false, permanent: false, error: 'sim_no_value' }
  return {
    ok: true,
    accounts: Array.isArray(value.accounts) ? value.accounts : [],
    err: value.err ?? null,
    logs: Array.isArray(value.logs) ? value.logs : [],
    unitsConsumed: typeof value.unitsConsumed === 'number' ? value.unitsConsumed : null,
  }
}

// On confirmation timeout, retry the status check a few times before giving
// up. Covers the case where transient RPC failures during normal polling
// caused us to never see a successful landing.
export async function getSignatureStatusWithRetry(
  env: Env,
  signature: string,
  attempts = 3,
): Promise<StatusResult> {
  let last: StatusResult = { confirmed: false }
  for (let i = 0; i < attempts; i++) {
    last = await getSignatureStatus(env, signature)
    if (last.confirmed || last.error) return last
  }
  return last
}
