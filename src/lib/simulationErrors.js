// Translate a Solana simulateTransaction failure into a user-friendly
// message plus structured details, using the per-instruction program
// summary produced by txDecoder so we can name the program that rejected
// the swap. Returns:
//   { message, details, logs }
// `message` is safe to show as the headline; `details` is a short technical
// hint (program name, instruction index, code, mined log line); `logs`
// is the raw array from the RPC, suitable for a collapsible block.

const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111'
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const DFLOW_PREDICT_PROGRAM_ID = 'pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb'

const PROGRAM_NAMES = {
  [SYSTEM_PROGRAM_ID]: 'System',
  [SPL_TOKEN_PROGRAM_ID]: 'SPL Token',
  [ATA_PROGRAM_ID]: 'Associated Token Account',
  [COMPUTE_BUDGET_PROGRAM_ID]: 'Compute Budget',
  [MEMO_PROGRAM_ID]: 'Memo',
  [DFLOW_PREDICT_PROGRAM_ID]: 'DFlow Predict',
}

// Standard SPL Token program error codes — see spl-token TokenError enum.
const SPL_TOKEN_ERRORS = {
  0: 'Account does not have enough SOL to be rent-exempt.',
  1: 'Insufficient token balance for this swap. Top up the input token (typically USDC) and try again.',
  2: 'Invalid token mint — DFlow may have stale market data.',
  3: 'Token mint mismatch — the DFlow swap referenced a different mint than this account.',
  4: 'Token account is not owned by the connected wallet.',
  5: 'Mint has a fixed supply.',
  6: 'Account is already in use.',
  9: 'Token account is uninitialized.',
  14: 'Numeric overflow.',
  17: 'Token account is frozen.',
  18: 'Token mint decimals mismatch.',
}

// Standard System program error codes.
const SYSTEM_ERRORS = {
  0: 'Account already in use.',
  1: 'Wallet has insufficient SOL for this transaction (would go negative).',
  3: 'Invalid account data.',
  5: 'Wallet has insufficient SOL for this transaction.',
}

function programLabel(programId) {
  if (!programId) return 'unknown program'
  return PROGRAM_NAMES[programId] || `program ${programId.slice(0, 8)}…`
}

function findInterestingLog(logs) {
  if (!Array.isArray(logs)) return null
  // Anchor errors look like: "Program log: AnchorError ... Error Message: <msg>."
  const anchor = logs.find(l => /AnchorError/i.test(l) && /Error Message:/i.test(l))
  if (anchor) {
    const m = /Error Message:\s*(.+?)\.?\s*$/i.exec(anchor)
    if (m) return m[1].trim()
  }
  // Generic "Program log: Error: ..."
  const errLog = logs.find(l => /Program log:.*Error/i.test(l))
  if (errLog) return errLog.replace(/^Program log:\s*/i, '').trim()
  // Fall back to anything mentioning "insufficient" / "failed".
  const fallback = logs.find(l => /insufficient|unauthorized|failed/i.test(l))
  return fallback || null
}

export function formatSimulationError({ error, logs = [], summary = [] }) {
  const out = {
    message: error || 'Simulation failed before signing.',
    details: '',
    logs: Array.isArray(logs) ? logs.slice() : [],
  }

  const m = /^Instruction (\d+) failed:\s*(.+)$/.exec(error || '')
  if (!m) {
    const hint = findInterestingLog(out.logs)
    if (hint) out.details = hint
    return out
  }

  const ixIndex = parseInt(m[1], 10)
  const detailStr = m[2]
  const ix = summary[ixIndex]
  const programId = ix?.programId
  const program = programLabel(programId)

  const customMatch = /"Custom"\s*:\s*(\d+)/.exec(detailStr)
  if (customMatch) {
    const code = parseInt(customMatch[1], 10)
    let friendly = null
    if (programId === SPL_TOKEN_PROGRAM_ID) friendly = SPL_TOKEN_ERRORS[code]
    else if (programId === SYSTEM_PROGRAM_ID) friendly = SYSTEM_ERRORS[code]

    out.message = friendly
      ? friendly
      : `${program} rejected the swap (instruction ${ixIndex}, code ${code}).`
    out.details = `${program} · instruction ${ixIndex} · code ${code}`
  } else {
    out.message = `${program} failed at instruction ${ixIndex}: ${detailStr}`
    out.details = `${program} · instruction ${ixIndex}`
  }

  const hint = findInterestingLog(out.logs)
  if (hint) {
    out.details = out.details ? `${out.details} — ${hint}` : hint
  }

  return out
}
