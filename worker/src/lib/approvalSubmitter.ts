// Approval-flow submitter. Builds the full swap transaction at fire time
// using the keeper's executor key, then broadcasts.
//
// Submit-time tx layout (executor signs everything, single signer):
//   instr 0: System::advanceNonceAccount (executor as authority)
//   instr 1: spl-token::transferChecked (user_ATA → executor_ATA,
//                                        signer = executor as delegate)
//   instr 2..N: DFlow /order swap instructions (userPublicKey=executor,
//                                               destinationWallet=user)
//
// On-chain pre-flight verification at fire time guards against DB
// tampering or order forgery: we re-read the user's token account from
// chain and assert (owner === row.wallet, mint === row.input_mint,
// delegate === executor, delegated_amount >= atomic) before signing.

import {
  Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Keypair,
  NONCE_ACCOUNT_LENGTH,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, createTransferCheckedInstruction,
  unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'

import type { Env } from '../env'
import { audit } from './audit'
import { incr } from './metrics'
import { loadExecutorKeypair } from './executor'
import {
  APPROVAL_PRIORITY_FEE_LAMPORTS, APPROVAL_FALLBACK_CU_LIMIT,
  APPROVAL_MIN_CU_PRICE_MICROLAMPORTS, SOLANA_TX_MAX_BYTES,
} from './constants'
import { sendRawTransaction, simulateTransaction } from './heliusRpc'
import { markOrderFailed } from './orderState'
import { classifyDflowHttp, type FailureCode } from './failureReason'
import {
  applyComputeUnitLimitFloor, applyComputeUnitPriceFloor,
  extractComputeUnitPrice,
} from './priorityFee'
import { deriveAtaCandidates, readSimulatedTokenAmount } from './simulation'
import { encrypt } from './encryption'

type ApprovalOrderRow = {
  id: string
  wallet: string
  market_ticker: string
  side: string
  order_type: string
  amount_usdc: number
  trigger_price: number
  user_input_ata: string
  input_mint: string
  output_mint: string
  delegated_amount_at_placement: number | null
  status: string
}

const USDC_DECIMALS = 6  // DFlow markets settle in USDC (6 decimals).
const OUTCOME_DECIMALS = 6  // DFlow outcome tokens use the same 6-decimal scale.

// Compute the atomic input amount + per-instruction decimal scale for an
// approval-flow row. For BUY orders the input is USDC denominated in dollars
// (amount_usdc directly). For SELL orders (stop-loss / take-profit) the
// input is outcome tokens denominated in shares = amount_usdc / trigger_price.
function computeInputAtomic(row: ApprovalOrderRow, usdcMint: string): { atomic: bigint; decimals: number } {
  const isSell = row.input_mint !== usdcMint
  if (isSell) {
    const trigger = row.trigger_price
    if (!(trigger > 0)) {
      throw new Error(`invalid trigger_price for sell row: ${trigger}`)
    }
    const shares = row.amount_usdc / trigger
    return {
      atomic: BigInt(Math.floor(shares * Math.pow(10, OUTCOME_DECIMALS))),
      decimals: OUTCOME_DECIMALS,
    }
  }
  return {
    atomic: BigInt(Math.floor(row.amount_usdc * Math.pow(10, USDC_DECIMALS))),
    decimals: USDC_DECIMALS,
  }
}

async function fail(env: Env, row: ApprovalOrderRow, code: FailureCode, raw?: string): Promise<void> {
  await markOrderFailed(env, row, code, 'approval', raw)
  await incr(env, 'submit_failed_permanent', { marketTicker: row.market_ticker, error: code, flow: 'approval' })
}

// Verify on-chain that the row's user_input_ata is genuinely owned by the
// row's wallet and that the executor holds the expected delegation. Catches
// DB tampering, ATA spoofing, and revocation-after-placement.
async function verifyDelegationOnChain(
  conn: Connection,
  row: ApprovalOrderRow,
  executor: Keypair,
  atomic: bigint,
): Promise<{ ok: true } | { ok: false; code: FailureCode; raw: string }> {
  const ata = new PublicKey(row.user_input_ata)
  const info = await conn.getAccountInfo(ata, 'confirmed').catch(() => null)
  if (!info) return { ok: false, code: 'ata_invalid', raw: 'user_input_ata_missing' }
  let acc
  try {
    acc = unpackAccount(ata, info, TOKEN_PROGRAM_ID)
  } catch (err) {
    return { ok: false, code: 'ata_invalid', raw: `unpack_failed: ${String(err)}` }
  }
  if (acc.owner.toBase58() !== row.wallet) {
    return { ok: false, code: 'ata_invalid', raw: `owner_mismatch: have=${acc.owner.toBase58()} want=${row.wallet}` }
  }
  if (acc.mint.toBase58() !== row.input_mint) {
    return { ok: false, code: 'ata_invalid', raw: `mint_mismatch: have=${acc.mint.toBase58()} want=${row.input_mint}` }
  }
  const executorPk = executor.publicKey.toBase58()
  if (!acc.delegate || acc.delegate.toBase58() !== executorPk) {
    return { ok: false, code: 'delegate_mismatch', raw: `delegate=${acc.delegate?.toBase58() ?? 'none'} want=${executorPk}` }
  }
  if (acc.delegatedAmount < atomic) {
    return {
      ok: false, code: 'delegation_insufficient',
      raw: `delegated=${acc.delegatedAmount.toString()} need=${atomic.toString()}`,
    }
  }
  return { ok: true }
}

export async function submitApprovalOrder(env: Env, orderId: string): Promise<void> {
  const row = await env.DB
    .prepare(
      `SELECT id, wallet, market_ticker, side, order_type, amount_usdc,
              trigger_price, user_input_ata, input_mint, output_mint,
              delegated_amount_at_placement, status
         FROM orders
        WHERE id = ? AND flow = 'approval'`,
    )
    .bind(orderId)
    .first<ApprovalOrderRow>()
  if (!row) {
    console.error('approval_submit_missing', { id: orderId })
    return
  }
  if (row.status !== 'armed') return

  const claimed = await env.DB
    .prepare(`UPDATE orders SET status = 'submitting', updated_at = ? WHERE id = ? AND status = 'armed'`)
    .bind(Date.now(), orderId)
    .run()
  if (claimed.meta.changes === 0) return

  let executor: Keypair
  try {
    executor = loadExecutorKeypair(env)
  } catch (err) {
    await fail(env, row, 'executor_key_unavailable', String(err))
    return
  }

  let atomicInput: { atomic: bigint; decimals: number }
  try {
    atomicInput = computeInputAtomic(row, env.USDC_MINT)
  } catch (err) {
    await fail(env, row, 'compute_input_invalid', String(err))
    return
  }

  const conn = new Connection(env.HELIUS_RPC_URL, 'confirmed')

  const verified = await verifyDelegationOnChain(conn, row, executor, atomicInput.atomic)
  if (!verified.ok) {
    await fail(env, row, verified.code, verified.raw)
    return
  }

  // Fetch DFlow /order with executor as userPublicKey and the user's wallet
  // as destinationWallet so the swap output lands in the user's account
  // directly. Both pubkeys must be Proof-verified at DFlow.
  let dflowTxBase64: string
  try {
    const params = new URLSearchParams({
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      amount: atomicInput.atomic.toString(),
      userPublicKey: executor.publicKey.toBase58(),
      destinationWallet: row.wallet,
      slippageBps: 'auto',
      priceImpactTolerancePct: '10',
      prioritizationFeeLamports: APPROVAL_PRIORITY_FEE_LAMPORTS,
    })
    const url = `${env.DFLOW_TRADE_BASE.replace(/\/+$/, '')}/order?${params.toString()}`
    const res = await fetch(url, {
      headers: {
        'x-api-key': env.DFLOW_API_KEY,
        'x-idempotency-key': `appr-${orderId}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      await fail(env, row, classifyDflowHttp(res.status), `dflow_http_${res.status}: ${text.slice(0, 240)}`)
      return
    }
    const dflowMeta: any = await res.json()
    if (!dflowMeta?.transaction) {
      await fail(env, row, 'dflow_no_transaction', 'dflow_no_transaction_field')
      return
    }
    dflowTxBase64 = dflowMeta.transaction
  } catch (err) {
    await fail(env, row, 'dflow_unreachable', String(err))
    return
  }

  // Decompile DFlow's tx, prepend advanceNonceAccount + transferChecked.
  const dflowBuf = Uint8Array.from(atob(dflowTxBase64), (c) => c.charCodeAt(0))
  const dflowTx = VersionedTransaction.deserialize(dflowBuf)

  const altAccounts: Array<any> = []
  for (const lookup of dflowTx.message.addressTableLookups ?? []) {
    const info = await conn.getAddressLookupTable(lookup.accountKey).catch(() => null)
    if (info?.value) altAccounts.push(info.value)
  }

  const decompiled = TransactionMessage.decompile(dflowTx.message, {
    addressLookupTableAccounts: altAccounts,
  })

  let noncePubkey: PublicKey
  let nonceValue: string
  try {
    const result = await ensureExecutorNonce(env, conn, executor, row.market_ticker)
    noncePubkey = result.noncePubkey
    nonceValue = result.nonceValue
  } catch (err) {
    const msg = String(err)
    const code: FailureCode = msg.includes('executor_underfunded')
      ? 'executor_underfunded'
      : 'nonce_unavailable'
    await fail(env, row, code, msg)
    return
  }

  const advanceIx = SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey: executor.publicKey,
  })

  const userATA = new PublicKey(row.user_input_ata)
  const inputMint = new PublicKey(row.input_mint)
  const executorATA = getAssociatedTokenAddressSync(inputMint, executor.publicKey)
  const transferIx = createTransferCheckedInstruction(
    userATA,
    inputMint,
    executorATA,
    executor.publicKey,
    atomicInput.atomic,
    atomicInput.decimals,
  )

  const dflowIxs = decompiled.instructions
  const cbIxs = dflowIxs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
  const swapIxs = dflowIxs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))
  // Enforce a SetComputeUnitPrice floor so DFlow's quote can't undercut
  // what's needed to land under mainnet congestion. When DFlow's quote
  // contains no compute-budget instructions at all, also inject a CU
  // limit fallback (DFlow normally sets one, but we have to assume some
  // limit if it didn't).
  const enforcedCbIxs = cbIxs.length === 0
    ? [
        ComputeBudgetProgram.setComputeUnitLimit({ units: APPROVAL_FALLBACK_CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: APPROVAL_MIN_CU_PRICE_MICROLAMPORTS }),
      ]
    : applyComputeUnitPriceFloor(cbIxs, APPROVAL_MIN_CU_PRICE_MICROLAMPORTS)

  // Build the base tx (advance + cb + pull + DFlow swap) and sign it for
  // simulation. The same byte-stream goes back through compileToV0Message
  // when we re-build with sweep/commission instructions appended.
  const baseInstructions: TransactionInstruction[] = [
    advanceIx,
    ...enforcedCbIxs,
    transferIx,
    ...swapIxs,
  ]
  const baseMessage = new TransactionMessage({
    payerKey: executor.publicKey,
    recentBlockhash: nonceValue,
    instructions: baseInstructions,
  }).compileToV0Message(altAccounts)
  const baseTx = new VersionedTransaction(baseMessage)
  baseTx.sign([executor])

  // Pre-broadcast simulation gate — verifies the swap will actually mint
  // outcome tokens to the user and tells us how much USDC remains on
  // the executor for sweeping. Without this, DFlow returning a non-swap
  // tx (e.g. InitUserOrderEscrow on book-based markets) would silently
  // consume user funds with no detectable position.
  const outcomeAtas = deriveAtaCandidates(row.output_mint, row.wallet)
  const simAddresses = [
    outcomeAtas.legacy.toBase58(),
    outcomeAtas.token2022.toBase58(),
    executorATA.toBase58(),
  ]
  const sim = await simulateTransaction(env, baseTx.serialize(), simAddresses)
  if (!sim.ok) {
    console.error('approval_simulate_rpc_failed', {
      id: orderId, error: sim.error, permanent: sim.permanent,
    })
    if (sim.permanent) {
      await fail(env, row, 'simulation_failed', sim.error)
    } else {
      // Transient — flip back to armed so reaper retries on next tick.
      await env.DB
        .prepare(`UPDATE orders SET status = 'armed', updated_at = ? WHERE id = ? AND status = 'submitting'`)
        .bind(Date.now(), orderId)
        .run()
      await incr(env, 'submit_failed_transient', { marketTicker: row.market_ticker, flow: 'approval' })
    }
    return
  }
  if (sim.err) {
    console.error('approval_simulate_tx_error', {
      id: orderId, err: sim.err, logs: sim.logs.slice(-10),
    })
    await fail(env, row, 'tx_error', JSON.stringify(sim.err).slice(0, 200))
    return
  }

  // Whichever ATA candidate (legacy SPL Token vs Token-2022) shows a
  // non-zero balance is the real outcome token account.
  const outcomeLegacy = readSimulatedTokenAmount(sim.accounts[0])
  const outcome2022 = readSimulatedTokenAmount(sim.accounts[1])
  const outcomeAmount = outcomeLegacy > 0n ? outcomeLegacy : outcome2022
  const executorPostUsdc = readSimulatedTokenAmount(sim.accounts[2])

  if (outcomeAmount === 0n) {
    console.error('approval_simulate_not_a_swap', {
      id: orderId,
      market: row.market_ticker,
      outputMint: row.output_mint,
      executorPostUsdc: Number(executorPostUsdc),
    })
    await fail(env, row, 'not_a_swap',
      `dflow_returned_non_swap_tx executor_post_usdc=${executorPostUsdc}`)
    return
  }

  // Sweep + commission split:
  //   residual         = USDC sitting on the executor after DFlow's ixs
  //   desiredCommission = amount_usdc * COMMISSION_BPS / 10000
  //   commission        = min(desiredCommission, residual)
  //   userRefund        = residual - commission
  //
  // Commission comes OUT of residual (not on top of the user's spend), so
  // a high-residual fire pays full fee + refund; a low-residual fire pays
  // capped fee + zero refund. Both env vars must be set for commission
  // to apply; otherwise residual goes entirely back to the user.
  const commissionBpsRaw = parseInt(env.COMMISSION_BPS ?? '0', 10)
  const commissionBps = Number.isFinite(commissionBpsRaw) && commissionBpsRaw > 0 ? commissionBpsRaw : 0
  const treasuryAtaStr = env.COMMISSION_RECIPIENT_USDC_ATA ?? ''
  const commissionConfigured = commissionBps > 0 && treasuryAtaStr.length > 0

  const desiredCommission = commissionConfigured
    ? (atomicInput.atomic * BigInt(commissionBps)) / 10000n
    : 0n

  // Validate the treasury USDC ATA on-chain before including a commission
  // transfer. A misconfigured env var (wallet pubkey instead of an ATA,
  // ATA on the wrong mint, or an uninitialized address) would otherwise
  // make every fire fail with InvalidAccountData. If validation fails,
  // skip commission for this fire and fold the would-be commission back
  // into the user refund — the user's order still completes, the operator
  // sees a clear warning in tail logs to fix the config.
  let commissionUsable = commissionConfigured && desiredCommission > 0n
  if (commissionUsable) {
    try {
      const treasuryPk = new PublicKey(treasuryAtaStr)
      const treasuryInfo = await conn.getAccountInfo(treasuryPk, 'confirmed')
      const ownerOk = treasuryInfo
        && (treasuryInfo.owner.equals(TOKEN_PROGRAM_ID) || treasuryInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
      const dataOk = treasuryInfo && treasuryInfo.data.length >= 72
      const mintMatches = dataOk
        && treasuryInfo!.data.slice(0, 32).every((b, i) => b === inputMint.toBytes()[i])
      if (!ownerOk || !dataOk || !mintMatches) {
        console.warn('approval_treasury_ata_invalid_skipping_commission', {
          id: orderId,
          ata: treasuryAtaStr,
          accountExists: !!treasuryInfo,
          ownerOk: !!ownerOk,
          mintMatches: !!mintMatches,
        })
        commissionUsable = false
      }
    } catch (err) {
      console.warn('approval_treasury_ata_check_failed_skipping_commission', {
        id: orderId, ata: treasuryAtaStr, error: String(err),
      })
      commissionUsable = false
    }
  }

  const commissionAmount = !commissionUsable
    ? 0n
    : desiredCommission > executorPostUsdc
      ? executorPostUsdc
      : desiredCommission
  const userRefundAmount = executorPostUsdc - commissionAmount

  const sweepIxs: TransactionInstruction[] = []
  if (commissionAmount > 0n) {
    sweepIxs.push(createTransferCheckedInstruction(
      executorATA,
      inputMint,
      new PublicKey(treasuryAtaStr),
      executor.publicKey,
      commissionAmount,
      USDC_DECIMALS,
    ))
  }
  if (userRefundAmount > 0n) {
    sweepIxs.push(createTransferCheckedInstruction(
      executorATA,
      inputMint,
      userATA,
      executor.publicKey,
      userRefundAmount,
      USDC_DECIMALS,
    ))
  }

  // DFlow's SetComputeUnitLimit is sized for THEIR instructions only;
  // each sweep TransferChecked we append consumes ~6,300 CU and would
  // push the tx past the limit, surfacing as ProgramFailedToComplete on
  // chain. Bump the CU limit using simulated base consumption + a fixed
  // per-sweep budget + safety margin so the floor scales with the actual
  // route cost rather than guessing.
  const SWEEP_IX_CU_BUDGET = 7_000
  const CU_SAFETY_MARGIN = 5_000
  const finalCbIxs = sweepIxs.length === 0
    ? enforcedCbIxs
    : applyComputeUnitLimitFloor(
        enforcedCbIxs,
        (sim.unitsConsumed ?? APPROVAL_FALLBACK_CU_LIMIT)
          + sweepIxs.length * SWEEP_IX_CU_BUDGET
          + CU_SAFETY_MARGIN,
      )

  const finalInstructions = sweepIxs.length === 0
    ? baseInstructions
    : [advanceIx, ...finalCbIxs, transferIx, ...swapIxs, ...sweepIxs]

  const finalMessage = new TransactionMessage({
    payerKey: executor.publicKey,
    recentBlockhash: nonceValue,
    instructions: finalInstructions,
  }).compileToV0Message(altAccounts)
  const recomposed = new VersionedTransaction(finalMessage)
  recomposed.sign([executor])

  const signedBytes = recomposed.serialize()
  if (signedBytes.length > SOLANA_TX_MAX_BYTES) {
    await fail(env, row, 'tx_oversized', `${signedBytes.length}_bytes`)
    return
  }

  // BigInt can't serialize through console.log's JSON path; coerce to
  // Number. CU prices fit comfortably under 2^53.
  const dflowCuPrice = extractComputeUnitPrice(cbIxs)
  const effectiveCuPrice = extractComputeUnitPrice(enforcedCbIxs)
  await incr(env, 'submit_attempted', { marketTicker: row.market_ticker, flow: 'approval' })
  console.log('approval_submit_attempt', {
    id: orderId,
    marketTicker: row.market_ticker,
    txBytes: signedBytes.length,
    dflowCuPrice: dflowCuPrice === null ? null : Number(dflowCuPrice),
    effectiveCuPrice: effectiveCuPrice === null ? null : Number(effectiveCuPrice),
    floorApplied: dflowCuPrice === null || (effectiveCuPrice !== null && dflowCuPrice < effectiveCuPrice),
    outcomeAmount: Number(outcomeAmount),
    executorResidual: Number(executorPostUsdc),
    commission: Number(commissionAmount),
    userRefund: Number(userRefundAmount),
    commissionSkipped: commissionConfigured && desiredCommission > 0n && !commissionUsable,
  })

  const broadcast = await sendRawTransaction(env, signedBytes)
  if (!broadcast.ok) {
    console.error('approval_submit_send_failed', {
      id: orderId, permanent: broadcast.permanent, error: broadcast.error,
    })
    if (broadcast.permanent) {
      await fail(env, row, 'rpc_error', broadcast.error)
    } else {
      await env.DB
        .prepare(`UPDATE orders SET status = 'armed', updated_at = ? WHERE id = ? AND status = 'submitting'`)
        .bind(Date.now(), orderId)
        .run()
      await audit(env, {
        wallet: row.wallet, orderId: row.id, event: 'submit.transient_failure',
        detail: { error: broadcast.error, flow: 'approval' },
      })
      await incr(env, 'submit_failed_transient', { marketTicker: row.market_ticker, flow: 'approval' })
    }
    return
  }

  // Encrypt the signed tx and persist alongside fill_signature so
  // checkSubmittedOrder can re-broadcast on subsequent alarm cycles
  // until the tx lands or CONFIRMATION_GIVE_UP_MS expires. Helius's
  // built-in maxRetries: 5 only covers ~150s — without this loop, txs
  // that need longer to land just time out as confirmation_timeout
  // even though the durable nonce is still valid.
  let signedEnc: { iv: Uint8Array; ciphertext: Uint8Array } | null = null
  try {
    signedEnc = await encrypt(signedBytes, env.SIGNED_TX_KEY)
  } catch (err) {
    // Encryption failures shouldn't block broadcast persistence — log
    // and continue. The tx already broadcast successfully; we just
    // won't have re-broadcast safety net for this fire.
    console.error('approval_submit_encrypt_failed', { id: orderId, error: String(err) })
  }

  await env.DB
    .prepare(`UPDATE orders SET fill_signature = ?, signed_tx_enc = ?, signed_tx_iv = ?, updated_at = ? WHERE id = ?`)
    .bind(
      broadcast.signature,
      signedEnc ? signedEnc.ciphertext : null,
      signedEnc ? signedEnc.iv : null,
      Date.now(),
      orderId,
    )
    .run()
  console.log('approval_submit_broadcast', { id: orderId, signature: broadcast.signature })
  await audit(env, {
    wallet: row.wallet, orderId: row.id, event: 'submit.broadcast',
    detail: { signature: broadcast.signature, marketTicker: row.market_ticker, flow: 'approval' },
  })
}

// Race-safe nonce-account allocation. Two concurrent triggers for a fresh
// market both try to provision a nonce. Without serialization, both create
// an on-chain account, both INSERT OR REPLACE, and one orphans ~0.0015 SOL.
//
// Strategy: pre-generate a candidate keypair and INSERT OR IGNORE the
// pubkey first. If the row was inserted, this caller owns the slot and
// performs the on-chain creation. If the row already exists, the loser
// reads back the winner's pubkey and waits for it to come live.
async function ensureExecutorNonce(
  env: Env,
  conn: Connection,
  executor: Keypair,
  marketTicker: string,
): Promise<{ noncePubkey: PublicKey; nonceValue: string }> {
  const executorPubkey = executor.publicKey.toBase58()

  const existing = await env.DB
    .prepare(`SELECT pubkey FROM durable_nonces WHERE wallet = ? AND market_ticker = ?`)
    .bind(executorPubkey, marketTicker)
    .first<{ pubkey: string }>()
  if (existing?.pubkey) {
    const live = await readNonceValue(conn, new PublicKey(existing.pubkey))
    if (live) return { noncePubkey: new PublicKey(existing.pubkey), nonceValue: live }
    // Stored row is stale (account closed). Fall through to claim a fresh slot.
    await env.DB
      .prepare(`DELETE FROM durable_nonces WHERE wallet = ? AND market_ticker = ? AND pubkey = ?`)
      .bind(executorPubkey, marketTicker, existing.pubkey)
      .run()
  }

  const candidate = Keypair.generate()
  const candidatePubkey = candidate.publicKey.toBase58()
  const claimAt = Date.now()
  const claim = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO durable_nonces
        (pubkey, wallet, market_ticker, current_nonce, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
    )
    .bind(candidatePubkey, executorPubkey, marketTicker, claimAt, claimAt)
    .run()

  if (claim.meta.changes === 0) {
    const winner = await env.DB
      .prepare(`SELECT pubkey FROM durable_nonces WHERE wallet = ? AND market_ticker = ?`)
      .bind(executorPubkey, marketTicker)
      .first<{ pubkey: string }>()
    if (!winner?.pubkey) throw new Error('nonce_claim_lost_but_no_winner')
    const winnerPk = new PublicKey(winner.pubkey)
    for (let i = 0; i < 30; i++) {
      const live = await readNonceValue(conn, winnerPk)
      if (live) return { noncePubkey: winnerPk, nonceValue: live }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('nonce_winner_never_initialized')
  }

  let created
  try {
    created = await createExecutorNonceAccount(conn, executor, candidate)
  } catch (err) {
    await env.DB
      .prepare(`DELETE FROM durable_nonces WHERE pubkey = ? AND current_nonce = ''`)
      .bind(candidatePubkey)
      .run()
    throw err
  }

  await env.DB
    .prepare(
      `UPDATE durable_nonces SET current_nonce = ?, updated_at = ? WHERE pubkey = ?`,
    )
    .bind(created.nonceValue, Date.now(), candidatePubkey)
    .run()

  return created
}

async function readNonceValue(conn: Connection, pubkey: PublicKey): Promise<string | null> {
  const info = await conn.getAccountInfo(pubkey, 'confirmed')
  if (!info) return null
  if (info.data.length < 80) return null
  const blockhash = info.data.slice(40, 72)
  return bs58.encode(blockhash)
}

// Headroom over rent for the nonce-init tx fee + any priority fee. Two
// signatures here (executor + nonce keypair) so 2 * 5000 base lamports plus
// a margin for compute-unit pricing.
const NONCE_INIT_FEE_BUFFER_LAMPORTS = 100_000

async function createExecutorNonceAccount(
  conn: Connection,
  executor: Keypair,
  noncePubkey: Keypair,
): Promise<{ noncePubkey: PublicKey; nonceValue: string }> {
  const rentLamports = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)
  // Surface an empty/underfunded executor wallet as a clear, actionable code
  // before we attempt the broadcast (which would otherwise fail with an
  // opaque RPC error and bucket as generic 'nonce_unavailable').
  const balance = await conn.getBalance(executor.publicKey, 'confirmed')
  const need = rentLamports + NONCE_INIT_FEE_BUFFER_LAMPORTS
  if (balance < need) {
    throw new Error(`executor_underfunded: balance=${balance} need>=${need}`)
  }
  const blockhashInfo = await conn.getLatestBlockhash('confirmed')

  const tx = new Transaction({
    feePayer: executor.publicKey,
    blockhash: blockhashInfo.blockhash,
    lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
  })
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: executor.publicKey,
      newAccountPubkey: noncePubkey.publicKey,
      lamports: rentLamports,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: noncePubkey.publicKey,
      authorizedPubkey: executor.publicKey,
    }),
  )
  tx.sign(
    { publicKey: executor.publicKey, secretKey: executor.secretKey } as any,
    { publicKey: noncePubkey.publicKey, secretKey: noncePubkey.secretKey } as any,
  )
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await conn.confirmTransaction(
    { signature: sig, blockhash: blockhashInfo.blockhash, lastValidBlockHeight: blockhashInfo.lastValidBlockHeight },
    'confirmed',
  )
  const value = await readNonceValue(conn, noncePubkey.publicKey)
  if (!value) throw new Error('nonce_account_unreadable_after_init')
  return { noncePubkey: noncePubkey.publicKey, nonceValue: value }
}

// Pre-warm the executor's durable-nonce account for a market so the first
// fire-time submission doesn't pay the on-chain creation cost. Idempotent;
// callers should `waitUntil` and not block on the result.
export async function warmExecutorNonceForMarket(env: Env, marketTicker: string): Promise<void> {
  let executor
  try {
    executor = loadExecutorKeypair(env)
  } catch {
    return
  }
  const conn = new Connection(env.HELIUS_RPC_URL, 'confirmed')
  await ensureExecutorNonce(env, conn, executor, marketTicker).catch((err) => {
    console.error('executor_nonce_warm_failed', { error: String(err), marketTicker })
  })
}
