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

// Walk simulation logs to find which program (and what depth) actually
// failed. Solana logs the call stack as `Program X invoke [depth]` /
// `Program X success` / `Program X failed: ...`, and a CPI from program A
// into program B will show B's failure even though the *outer* instruction
// is attributed to A. This lets us tell "DFlow Predict failed code 1" apart
// from "DFlow Predict's CPI into the System Program ran out of lamports".
function analyzeInvokeStack(logs) {
  if (!Array.isArray(logs)) return null
  const stack = []
  let lastInvoked = null
  let failingProgram = null
  let failLine = null
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]/.exec(line)
    if (invoke) {
      const depth = parseInt(invoke[2], 10)
      stack.length = depth - 1
      stack.push(invoke[1])
      lastInvoked = invoke[1]
      continue
    }
    if (/^Program \S+ success/.test(line)) {
      stack.pop()
      continue
    }
    const failed = /^Program (\S+) failed:/.exec(line)
    if (failed) {
      failingProgram = failed[1]
      failLine = line
      break
    }
  }
  return { failingProgram: failingProgram || lastInvoked, failLine, depth: stack.length }
}

// "Transfer: insufficient lamports X, need Y" comes from the System Program
// when a CPI tries to move SOL it doesn't have. Unambiguous SOL shortage.
function detectInsufficientLamports(logs) {
  if (!Array.isArray(logs)) return null
  const line = logs.find(l => /Transfer:\s*insufficient lamports/i.test(l))
  if (!line) return null
  const m = /insufficient lamports\s+(\d+),\s*need\s+(\d+)/i.exec(line)
  if (m) {
    const have = parseInt(m[1], 10)
    const need = parseInt(m[2], 10)
    return { have, need, line }
  }
  return { have: null, need: null, line }
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
  const stack = analyzeInvokeStack(out.logs)
  const lamports = detectInsufficientLamports(out.logs)
  const innerFail = stack?.failingProgram && stack.failingProgram !== programId
    ? stack.failingProgram
    : null

  if (customMatch) {
    const code = parseInt(customMatch[1], 10)
    let friendly = null

    // Outer attribution maps cleanly for known programs.
    if (programId === SPL_TOKEN_PROGRAM_ID) friendly = SPL_TOKEN_ERRORS[code]
    else if (programId === SYSTEM_PROGRAM_ID) friendly = SYSTEM_ERRORS[code]

    // CPI failure: outer is DFlow / unknown, but the actual failing program
    // is something we *can* interpret. This is the common case for
    // "DFlow Predict instruction 2, code 1" where the real cause is a
    // System Program lamports shortage during account creation.
    if (!friendly && innerFail) {
      if (lamports) {
        friendly = lamports.need
          ? `Wallet has insufficient SOL. The transaction tried to move ${(lamports.need / 1e9).toFixed(6)} SOL but only ${(lamports.have / 1e9).toFixed(6)} was available. Add SOL to cover network fees and account rent, then try again.`
          : 'Wallet has insufficient SOL. The transaction needs SOL to cover network fees and rent for new accounts. Add SOL and try again.'
      } else if (innerFail === SYSTEM_PROGRAM_ID) {
        friendly = `${programLabel(programId)} failed during a System Program call (likely creating or funding an account). Most often this means the wallet does not have enough SOL for fees and account rent — top up SOL and try again.`
      } else if (innerFail === SPL_TOKEN_PROGRAM_ID && code === 1) {
        friendly = 'Insufficient token balance for this swap. Top up the input token (typically USDC) and try again.'
      }
    }

    if (!friendly) {
      friendly = `${program} rejected the swap (instruction ${ixIndex}, code ${code}).`
    }

    out.message = friendly
    out.details = `${program} · instruction ${ixIndex} · code ${code}`
    if (innerFail) {
      out.details += ` · inner CPI: ${programLabel(innerFail)}`
    }
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
